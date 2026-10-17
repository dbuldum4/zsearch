#if os(macOS)
import AVFoundation
import AVKit
import SwiftUI
import ZSearchKit

/// Plays a recording from a moment in its transcript. The preview panes share one player, so
/// switching between File and Transcript keeps it playing.
@MainActor
@Observable
final class Playback {
    static let shared = Playback()

    /// The recording in `player`, once something asked to play it.
    private(set) var path: String?
    let player = AVPlayer()

    func play(_ path: String, from seconds: Double) {
        if self.path != path {
            // As the transcriber reads it: a reference movie must not fetch another file or URL.
            let asset = AVURLAsset(url: URL(fileURLWithPath: path), options: [AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue])
            player.replaceCurrentItem(with: AVPlayerItem(asset: asset))
            self.path = path
        }
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        player.play()
    }

    /// Stop playing, unless `path` is the recording that plays (it was selected to play it).
    func stop(unless path: String? = nil) {
        guard self.path != nil, self.path != path else { return }
        player.pause()
        player.replaceCurrentItem(with: nil)
        self.path = nil
    }

    func isPlaying(_ p: FilePreview) -> Bool {
        path == p.path
    }
}

/// The shared player with AVKit's controls.
struct MediaPlayerView: NSViewRepresentable {
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.player = Playback.shared.player
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {}

    static func dismantleNSView(_ view: AVPlayerView, coordinator: ()) {
        view.player = nil
    }
}

/// Above a transcript while its recording plays from one of its stamps.
struct TranscriptPlayer: View {
    let preview: FilePreview

    var body: some View {
        if Playback.shared.isPlaying(preview) {
            HStack(spacing: 6) {
                MediaPlayerView()
                Button {
                    Playback.shared.stop()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Stop playing")
                .padding(.trailing, 8)
            }
            .frame(height: preview.kind == "video" ? 220 : 44)
            Divider()
        }
    }
}

/// "Play from 00:01:23": the recording from the segment of the preview's focused match.
struct PlayFromButton: View {
    let preview: FilePreview

    var body: some View {
        if let start = Transcript.start(of: preview) {
            Button {
                Playback.shared.play(preview.path, from: start)
            } label: {
                Label("Play from \(Transcript.format(start))", systemImage: "play.fill")
            }
            .controlSize(.small)
            .help("Play the recording from the segment of this match")
        }
    }
}
#endif
