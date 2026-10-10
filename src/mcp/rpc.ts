/**
 * A small Model Context Protocol server: JSON-RPC 2.0 messages, one per line, over stdio.
 *
 * It implements the parts of the protocol a local tool server needs: version negotiation,
 * tools (with input validation, structured results and progress), resources and resource
 * templates, prompts, argument completion, logging, ping and cancellation. It knows nothing
 * about zsearch; `server.ts` registers the tools.
 */
import { createInterface } from "node:readline"

/** Newest first. A client asking for another version is answered with the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  minimum?: number
  maximum?: number
  default?: unknown
  additionalProperties?: boolean
}

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolContext {
  /** Aborted when the client cancels the call or the server shuts down. */
  signal: AbortSignal
  /** Report progress, if the client asked for it with a progress token (otherwise a no-op). */
  progress(progress: number, total?: number, message?: string): void
}

export interface ToolResult {
  /** What the model reads. */
  text: string
  /** The same result as data, matching the tool's `outputSchema`. */
  structured?: Record<string, unknown>
  isError?: boolean
}

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: ToolAnnotations
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export interface ResourceContents {
  uri: string
  mimeType: string
  text: string
}

export interface Resource {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  read(): Promise<ResourceContents>
}

export interface ResourceTemplate {
  uriTemplate: string
  name: string
  title: string
  description: string
  mimeType: string
  /** The resource at `uri`, or null when `uri` is not one of this template's. */
  read(uri: string): Promise<ResourceContents | null>
  complete?(argument: string, value: string): Promise<string[]>
}

export interface PromptMessage {
  role: "user" | "assistant"
  content: { type: "text"; text: string } | { type: "resource"; resource: ResourceContents }
}

export interface Prompt {
  name: string
  title: string
  description: string
  arguments: { name: string; description: string; required?: boolean }[]
  get(args: Record<string, string>): Promise<{ description?: string; messages: PromptMessage[] }>
  complete?(argument: string, value: string): Promise<string[]>
}

export interface ServerInfo {
  name: string
  title: string
  version: string
  instructions?: string
}

export interface ServerParts {
  tools: Tool[]
  resources?: Resource[]
  templates?: ResourceTemplate[]
  prompts?: Prompt[]
}

export const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** A failure a tool reports to the model as an `isError` result, in its own words. */
export class ToolError extends Error {}

/** A protocol-level error, answered as a JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export const ErrorCode = { Parse: -32700, InvalidRequest: -32600, MethodNotFound: -32601, InvalidParams: -32602, Internal: -32603, ResourceNotFound: -32002 } as const

type Id = string | number

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export class McpServer {
  /** The negotiated protocol version. */
  protocolVersion = PROTOCOL_VERSIONS[0]!
  clientInfo: { name?: string; version?: string } = {}
  private logLevel: LogLevel = "info"
  private inflight = new Map<Id, AbortController>()

  constructor(
    private info: ServerInfo,
    private parts: ServerParts,
    private write: (line: string) => void,
  ) {}

  /** Structured results, tool titles and output schemas arrived in 2025-06-18. */
  private get modern(): boolean {
    return this.protocolVersion >= "2025-06-18"
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write(JSON.stringify(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method }))
  }

  /** Send a log message to the client, if it is at or above the level the client asked for. */
  log(level: LogLevel, data: unknown): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.logLevel)) return
    this.notify("notifications/message", { level, logger: this.info.name, data })
  }

  /** Abort every call in flight (the client went away). */
  close(): void {
    for (const c of this.inflight.values()) c.abort()
  }

  /** Handle one line from the client and write the reply, if any. */
  async receive(line: string): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch (e) {
      this.write(JSON.stringify(errorReply(null, ErrorCode.Parse, `parse error: ${(e as Error).message}`)))
      return
    }
    if (Array.isArray(msg)) {
      // Batches were part of the 2025-03-26 revision; still accepted.
      if (!msg.length) return this.write(JSON.stringify(errorReply(null, ErrorCode.InvalidRequest, "empty batch")))
      const replies = (await Promise.all(msg.map((m) => this.dispatch(m)))).filter((r) => r !== null)
      if (replies.length) this.write(JSON.stringify(replies))
      return
    }
    const reply = await this.dispatch(msg)
    if (reply) this.write(JSON.stringify(reply))
  }

  private async dispatch(msg: unknown): Promise<object | null> {
    if (!isObject(msg) || msg.jsonrpc !== "2.0") return errorReply(isObject(msg) ? validId(msg.id) : null, ErrorCode.InvalidRequest, "invalid request: expected a JSON-RPC 2.0 message")
    const { method, params } = msg
    const id = validId(msg.id)
    if (typeof method !== "string") {
      // A response to a request: this server sends none, so there is nothing to match.
      if ("result" in msg || "error" in msg) return null
      return errorReply(id, ErrorCode.InvalidRequest, "invalid request: no method")
    }
    if (params !== undefined && !isObject(params)) return id === null ? null : errorReply(id, ErrorCode.InvalidParams, "params must be an object")
    const p = (params ?? {}) as Record<string, unknown>
    if (msg.id === undefined) {
      this.notification(method, p)
      return null
    }
    if (id === null) return errorReply(null, ErrorCode.InvalidRequest, "invalid request: id must be a string or a number")
    const controller = new AbortController()
    this.inflight.set(id, controller)
    try {
      const result = await this.request(method, p, controller.signal)
      // A cancelled request gets no reply.
      return controller.signal.aborted ? null : { jsonrpc: "2.0", id, result }
    } catch (e) {
      if (controller.signal.aborted) return null
      if (e instanceof RpcError) return errorReply(id, e.code, e.message)
      return errorReply(id, ErrorCode.Internal, (e as Error).message || String(e))
    } finally {
      this.inflight.delete(id)
    }
  }

  private notification(method: string, params: Record<string, unknown>): void {
    if (method === "notifications/cancelled") {
      const id = validId(params.requestId)
      if (id !== null) this.inflight.get(id)?.abort()
    }
    // notifications/initialized, notifications/roots/list_changed and others need nothing.
  }

  private async request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    switch (method) {
      case "initialize":
        return this.initialize(params)
      case "ping":
        return {}
      case "tools/list":
        return { tools: this.parts.tools.map((t) => this.describeTool(t)) }
      case "tools/call":
        return this.callTool(params, signal)
      case "resources/list":
        return { resources: (this.parts.resources ?? []).map(({ uri, name, title, description, mimeType }) => this.titled({ uri, name, title, description, mimeType })) }
      case "resources/templates/list":
        return { resourceTemplates: (this.parts.templates ?? []).map(({ uriTemplate, name, title, description, mimeType }) => this.titled({ uriTemplate, name, title, description, mimeType })) }
      case "resources/read":
        return this.readResource(params)
      case "prompts/list":
        return { prompts: (this.parts.prompts ?? []).map(({ name, title, description, arguments: args }) => this.titled({ name, title, description, arguments: args })) }
      case "prompts/get":
        return this.getPrompt(params)
      case "completion/complete":
        return this.complete(params)
      case "logging/setLevel": {
        const level = params.level as LogLevel
        if (!LOG_LEVELS.includes(level)) throw new RpcError(ErrorCode.InvalidParams, `unknown log level "${String(params.level)}"`)
        this.logLevel = level
        return {}
      }
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `method not found: ${method}`)
    }
  }

  private initialize(params: Record<string, unknown>): Record<string, unknown> {
    const asked = String(params.protocolVersion ?? "")
    this.protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]!
    if (isObject(params.clientInfo)) this.clientInfo = params.clientInfo as typeof this.clientInfo
    const capabilities: Record<string, unknown> = { tools: { listChanged: false }, logging: {}, completions: {} }
    if (this.parts.resources?.length || this.parts.templates?.length) capabilities.resources = { subscribe: false, listChanged: false }
    if (this.parts.prompts?.length) capabilities.prompts = { listChanged: false }
    const { name, title, version, instructions } = this.info
    return {
      protocolVersion: this.protocolVersion,
      capabilities,
      serverInfo: this.titled({ name, title, version }),
      ...(instructions ? { instructions } : {}),
    }
  }

  /** Drop `title` for clients older than 2025-06-18, which did not know it. */
  private titled<T extends { title?: string }>(o: T): T {
    if (this.modern) return o
    const { title: _, ...rest } = o
    return rest as T
  }

  private describeTool(t: Tool): Record<string, unknown> {
    const out: Record<string, unknown> = { name: t.name, description: t.description, inputSchema: t.inputSchema }
    if (this.modern) {
      out.title = t.title
      if (t.outputSchema) out.outputSchema = t.outputSchema
    }
    if (t.annotations) out.annotations = this.modern ? { title: t.title, ...t.annotations } : t.annotations
    return out
  }

  private async callTool(params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const tool = this.parts.tools.find((t) => t.name === params.name)
    if (!tool) throw new RpcError(ErrorCode.InvalidParams, `unknown tool: ${String(params.name)}`)
    const rawArgs = params.arguments ?? {}
    const { value: args, errors } = checkArgs(tool.inputSchema, rawArgs)
    // Bad arguments are the model's to fix, so they come back as a tool error it can read.
    if (errors.length) return this.toolResult({ text: `Invalid arguments for ${tool.name}: ${errors.join("; ")}`, isError: true })
    const token = isObject(params._meta) ? params._meta.progressToken : undefined
    let last = -Infinity
    const ctx: ToolContext = {
      signal,
      progress: (progress, total, message) => {
        if ((typeof token !== "string" && typeof token !== "number") || signal.aborted || progress <= last) return
        last = progress
        this.notify("notifications/progress", { progressToken: token, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) })
      },
    }
    try {
      return this.toolResult(await tool.run(args, ctx))
    } catch (e) {
      const message = (e as Error).message || String(e)
      return this.toolResult({ text: e instanceof ToolError ? message : `${tool.name} failed: ${message}`, isError: true })
    }
  }

  private toolResult(r: ToolResult): Record<string, unknown> {
    const out: Record<string, unknown> = { content: [{ type: "text", text: r.text }] }
    if (r.structured && this.modern && !r.isError) out.structuredContent = r.structured
    if (r.isError) out.isError = true
    return out
  }

  private async readResource(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const uri = params.uri
    if (typeof uri !== "string") throw new RpcError(ErrorCode.InvalidParams, "resources/read needs a uri")
    const fixed = this.parts.resources?.find((r) => r.uri === uri)
    if (fixed) return { contents: [await fixed.read()] }
    for (const t of this.parts.templates ?? []) {
      const contents = await t.read(uri)
      if (contents) return { contents: [contents] }
    }
    throw new RpcError(ErrorCode.ResourceNotFound, `resource not found: ${uri}`)
  }

  private async getPrompt(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prompt = this.parts.prompts?.find((p) => p.name === params.name)
    if (!prompt) throw new RpcError(ErrorCode.InvalidParams, `unknown prompt: ${String(params.name)}`)
    const args: Record<string, string> = {}
    if (isObject(params.arguments)) for (const [k, v] of Object.entries(params.arguments)) if (typeof v === "string") args[k] = v
    for (const a of prompt.arguments) if (a.required && !args[a.name]?.trim()) throw new RpcError(ErrorCode.InvalidParams, `prompt ${prompt.name} needs the argument "${a.name}"`)
    try {
      return { ...(await prompt.get(args)) }
    } catch (e) {
      if (e instanceof ToolError) throw new RpcError(ErrorCode.InvalidParams, e.message)
      throw e
    }
  }

  private async complete(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ref = isObject(params.ref) ? params.ref : {}
    const arg = isObject(params.argument) ? params.argument : {}
    const name = String(arg.name ?? "")
    const value = String(arg.value ?? "")
    let values: string[] = []
    if (ref.type === "ref/prompt") {
      const prompt = this.parts.prompts?.find((p) => p.name === ref.name)
      if (!prompt) throw new RpcError(ErrorCode.InvalidParams, `unknown prompt: ${String(ref.name)}`)
      values = (await prompt.complete?.(name, value)) ?? []
    } else if (ref.type === "ref/resource") {
      const t = this.parts.templates?.find((t) => t.uriTemplate === ref.uri)
      if (!t) throw new RpcError(ErrorCode.InvalidParams, `unknown resource template: ${String(ref.uri)}`)
      values = (await t.complete?.(name, value)) ?? []
    } else throw new RpcError(ErrorCode.InvalidParams, "completion/complete needs a ref/prompt or ref/resource")
    return { completion: { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 } }
  }
}

function validId(id: unknown): Id | null {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? id : null
}

function errorReply(id: Id | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

/* ------------------------------------------------------------ arguments -- */

function typeOf(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number"
  return typeof v
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v)
  return want === t || (want === "number" && t === "integer")
}

/**
 * Check tool arguments against the subset of JSON Schema the tools use, filling in defaults.
 * It forgives what models commonly get slightly wrong: a number or boolean sent as a string,
 * or a single string where a list of strings is expected.
 */
export function checkArgs(schema: JsonSchema, value: unknown, path = ""): { value: Record<string, unknown>; errors: string[] } {
  const errors: string[] = []
  const out = coerce(schema, value, path || "arguments", errors)
  return { value: (isObject(out) ? out : {}) as Record<string, unknown>, errors }
}

function coerce(schema: JsonSchema, v: unknown, path: string, errors: string[]): unknown {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.length && !types.some((t) => typeMatches(t, v))) {
    if (typeof v === "string" && (types.includes("integer") || types.includes("number")) && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v)
    else if (typeof v === "string" && types.includes("boolean") && /^(true|false)$/i.test(v)) v = v.toLowerCase() === "true"
    else if (typeof v === "string" && types.includes("array") && (schema.items?.type ?? "string") === "string") v = [v]
    if (!types.some((t) => typeMatches(t, v))) {
      errors.push(`${path} should be ${types.join(" or ")}, not ${typeOf(v)}`)
      return v
    }
  }
  if (schema.enum && !schema.enum.includes(v)) errors.push(`${path} should be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`)
  if (typeof v === "number") {
    if (types.includes("integer") && !types.includes("number") && !Number.isInteger(v)) errors.push(`${path} should be a whole number`)
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path} should be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path} should be at most ${schema.maximum}`)
  }
  if (Array.isArray(v) && schema.items) return v.map((x, i) => coerce(schema.items!, x, `${path}[${i}]`, errors))
  if (isObject(v) && schema.properties) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const sub = schema.properties[k]
      if (sub) out[k] = coerce(sub, x, path === "arguments" ? k : `${path}.${k}`, errors)
      else if (schema.additionalProperties === false) errors.push(`unknown ${path === "arguments" ? "argument" : `property in ${path}`}: ${k}`)
      else out[k] = x
    }
    for (const [k, sub] of Object.entries(schema.properties)) if (!(k in out) && sub.default !== undefined) out[k] = structuredClone(sub.default)
    for (const k of schema.required ?? []) if (!(k in out)) errors.push(`missing required ${path === "arguments" ? "argument" : `property in ${path}`}: ${k}`)
    return out
  }
  return v
}

/* ---------------------------------------------------------------- stdio -- */

/**
 * Serve `server` on stdin/stdout until stdin closes. Calls still running then get `graceMs` to
 * finish (their replies still go out), and are cancelled after that.
 */
export async function serveStdio(server: McpServer, input: NodeJS.ReadableStream = process.stdin, graceMs = 10_000): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  const pending = new Set<Promise<void>>()
  for await (const line of lines) {
    if (!line.trim()) continue
    const task = server.receive(line)
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.allSettled(pending), new Promise((r) => (timer = setTimeout(r, graceMs)))])
  clearTimeout(timer)
  server.close()
  await Promise.allSettled(pending)
}
