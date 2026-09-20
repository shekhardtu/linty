// Native control for scripts/probe-correction-accessibility.swift.
// Displays a background window for six seconds, changes synthetic text twice,
// then clears it. Does not activate the app, send keys, or use the clipboard.
// Compile with swiftc and probe the resulting process ID from another process.
import AppKit

let sessionMode = CommandLine.arguments.contains("--session")
let previous = NSWorkspace.shared.frontmostApplication
let app = NSApplication.shared
app.setActivationPolicy(sessionMode ? .regular : .accessory)
let window = NSWindow(
    contentRect: NSRect(x: 80, y: 80, width: 400, height: 100),
    styleMask: [.titled], backing: .buffered, defer: false
)
let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
text.string = "My name is Hari Shekhar. I go to YOLO."
window.contentView = text
window.makeFirstResponder(text)
if sessionMode {
    window.makeKeyAndOrderFront(nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        app.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(text)
    }
} else { window.orderBack(nil) }
var step = 0
let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { timer in
    step += 1
    if step == 1 { text.string = "My name is Harishekhar. I go to YOLO." }
    if step == 2 { text.string = "My name is Harishekhar. I go to YULU." }
    if step == 3 {
        if sessionMode { previous?.activate() }
        else { text.string = "" }
    }
    if step == 5 && sessionMode { text.string = "" }
    text.didChangeText()
    text.setSelectedRange(NSRange(location: text.string.utf16.count, length: 0))
    if step == 6 { timer.invalidate(); app.terminate(nil) }
}
app.run()
