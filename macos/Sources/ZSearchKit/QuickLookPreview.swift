import Foundation

/// Shared by preview preparation and the pane, so files shown by Quick Look don't wait for
/// styled text. Indexed text stays available through the pane's File/Text switch.
public enum QuickLookPreview {
    public static func isOffice(_ preview: FilePreview) -> Bool {
        preview.kind == "sheet" || preview.kind == "slides"
    }

    public static func handles(_ preview: FilePreview) -> Bool {
        !preview.isDir && preview.contentAllowed != false
            && (isOffice(preview) || ["image", "video", "audio", "font"].contains(preview.kind) || preview.message != nil)
    }

    public static func showsFile(_ preview: FilePreview, showsText: Bool) -> Bool {
        handles(preview) && (!showsText || preview.message != nil)
    }
}
