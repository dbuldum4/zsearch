// Local file transcription. No microphone, server recognizer, or third-party model.
// Final segments are JSON lines, so the engine can preserve completed work on a deadline.
import Foundation

func emit(_ value: [String: Any]) throws {
    var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    data.append(0x0A)
    try FileHandle.standardOutput.write(contentsOf: data)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

#if os(macOS) && compiler(>=6.2)
import AVFoundation
import Speech

struct TranscriptionError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// One consumer pulls one decoded buffer at a time. No unbounded producer queue or PCM temp file.
@available(macOS 26, *)
struct AudioInputs: AsyncSequence, Sendable {
    typealias Element = AnalyzerInput
    let iterator: Iterator
    func makeAsyncIterator() -> Iterator { iterator }

    // AVAssetReader and its output are confined to this sequence's single iterator.
    final class Iterator: AsyncIteratorProtocol, @unchecked Sendable {
        let reader: AVAssetReader
        let output: AVAssetReaderTrackOutput
        let format: AVAudioFormat

        init(reader: AVAssetReader, output: AVAssetReaderTrackOutput, format: AVAudioFormat) {
            self.reader = reader; self.output = output; self.format = format
        }

        func next() async throws -> AnalyzerInput? {
            try Task.checkCancellation()
            return try autoreleasepool {
                guard let sample = output.copyNextSampleBuffer() else {
                    if reader.status == .failed { throw reader.error ?? TranscriptionError(message: "could not decode the audio track") }
                    return nil
                }
                let count = CMSampleBufferGetNumSamples(sample)
                guard count > 0, count <= 1_000_000,
                      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else {
                    throw TranscriptionError(message: "invalid decoded audio buffer")
                }
                buffer.frameLength = AVAudioFrameCount(count)
                let code = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(count), into: buffer.mutableAudioBufferList)
                guard code == noErr else { throw TranscriptionError(message: "could not copy decoded audio (\(code))") }
                return AnalyzerInput(buffer: buffer, bufferStartTime: CMSampleBufferGetPresentationTimeStamp(sample))
            }
        }
    }
}

@available(macOS 26, *)
func makeTranscriber(language: String) async throws -> SpeechTranscriber {
    guard SpeechTranscriber.isAvailable else { throw TranscriptionError(message: "Apple on-device speech is unavailable on this Mac") }
    let requested = language.isEmpty ? Locale.current : Locale(identifier: language)
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
        throw TranscriptionError(message: "Apple speech does not support \(requested.identifier); set content.transcriptionLocale to a supported spoken language")
    }
    return SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
}

@available(macOS 26, *)
func prepareAssets(_ transcriber: SpeechTranscriber) async throws {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        FileHandle.standardError.write(Data("Downloading Apple speech language assets…\n".utf8))
        try await request.downloadAndInstall()
    }
}

@available(macOS 26, *)
func transcribeFile(path: String, language: String, maxSeconds: Double, maxChars: Int) async throws {
    let url = URL(fileURLWithPath: path)
    // A reference movie must not fetch another file or URL outside the indexed file's policy.
    let asset = AVURLAsset(url: url, options: [AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue])
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard let track = tracks.first else { throw TranscriptionError(message: "no audio track in this file") }
    let duration = try await asset.load(.duration).seconds
    guard duration.isFinite, duration > 0 else { throw TranscriptionError(message: "audio duration is unavailable") }
    let transcriber = try await makeTranscriber(language: language)
    // Assets are managed and shared by macOS; only the language model is downloaded, never audio.
    try await prepareAssets(transcriber)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        throw TranscriptionError(message: "no compatible speech audio format")
    }
    let reader = try AVAssetReader(asset: asset)
    defer { reader.cancelReading() }
    reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: min(duration, maxSeconds), preferredTimescale: 600))
    let floating = format.commonFormat == .pcmFormatFloat32 || format.commonFormat == .pcmFormatFloat64
    let bits = format.commonFormat == .pcmFormatInt16 ? 16 : format.commonFormat == .pcmFormatFloat64 ? 64 : 32
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate,
        AVNumberOfChannelsKey: format.channelCount, AVLinearPCMBitDepthKey: bits,
        AVLinearPCMIsFloatKey: floating, AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: !format.isInterleaved,
    ])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw TranscriptionError(message: "unsupported audio encoding") }
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? TranscriptionError(message: "could not open audio track") }
    let inputs = AudioInputs(iterator: .init(reader: reader, output: output, format: format))
    let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .background, modelRetention: .whileInUse))
    let results = Task {
        var characters = 0
        for try await result in transcriber.results {
            let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            let remaining = maxChars - characters
            guard remaining > 0 else { await analyzer.cancelAndFinishNow(); return true }
            try emit(["start": max(0, result.range.start.seconds), "text": String(text.prefix(remaining))])
            characters += text.count + 1
            if characters >= maxChars { await analyzer.cancelAndFinishNow(); return true }
        }
        return false
    }
    do {
        if let end = try await analyzer.analyzeSequence(inputs) {
            try await analyzer.finalizeAndFinish(through: end)
        } else { await analyzer.cancelAndFinishNow() }
        let textLimited = try await results.value
        try emit(["complete": true, "truncated": duration > maxSeconds || textLimited])
    } catch {
        await analyzer.cancelAndFinishNow()
        results.cancel()
        // A character limit intentionally cancels input. Keep its finalized segments.
        if (try? await results.value) == true {
            try emit(["complete": true, "truncated": true])
        } else { throw error }
    }
}

@main struct Main {
    static func main() async {
        setpriority(PRIO_PROCESS, 0, 10)
        let args = CommandLine.arguments
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        if args.dropFirst().first == "--version" { print("zsearch-transcribe 1 (Apple SpeechAnalyzer)"); return }
        guard #available(macOS 26, *) else { fail("on-device transcription needs macOS 26 or newer") }
        do {
            if args.dropFirst().first == "--prepare" {
                let transcriber = try await makeTranscriber(language: value("--locale") ?? "")
                try await prepareAssets(transcriber)
                try emit(["ready": true])
                return
            }
            if args.dropFirst().first == "--status" {
                let transcriber = try await makeTranscriber(language: value("--locale") ?? "")
                try emit(["available": true, "installed": await AssetInventory.status(forModules: [transcriber]) == .installed,
                          "locale": transcriber.selectedLocales.first?.identifier ?? ""])
                return
            }
            guard args.count >= 3, args[1] == "transcribe" else { fail("usage: zsearch-transcribe transcribe <file> [--locale en-US] [--max-seconds N] [--max-chars N] | --status | --version") }
            let seconds = Double(value("--max-seconds") ?? "7200") ?? 0
            let chars = Int(value("--max-chars") ?? "2000000") ?? 0
            guard seconds.isFinite, seconds > 0, seconds <= 7200, chars > 0, chars <= 2_000_000 else { fail("invalid transcription limits") }
            try await transcribeFile(path: args[2], language: value("--locale") ?? "", maxSeconds: seconds, maxChars: chars)
        } catch { fail(error.localizedDescription) }
    }
}
#else
@main struct Main {
    static func main() { fail("on-device transcription needs macOS 26+ and a build with the macOS 26 SDK") }
}
#endif
