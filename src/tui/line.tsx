import type { TextRenderable } from "@opentui/core"
import { createEffect } from "solid-js"
import { fitSegs, type Seg, toStyled } from "./styled.ts"

/**
 * One terminal row of styled segments. The Solid binding stringifies a `content`
 * prop, so StyledText is assigned to the renderable directly.
 */
export function StyledLine(props: { segs: Seg[]; width?: number; bg?: string; height?: number }) {
  let node: TextRenderable | undefined
  const styled = () => toStyled(props.width !== undefined ? fitSegs(props.segs, props.width) : props.segs)
  createEffect(() => {
    const s = styled()
    if (node) node.content = s
  })
  return (
    <text
      ref={(r: TextRenderable) => {
        node = r
        r.content = styled()
      }}
      wrapMode="none"
      height={props.height ?? 1}
      width={props.width}
      bg={props.bg}
      selectable={false}
    />
  )
}
