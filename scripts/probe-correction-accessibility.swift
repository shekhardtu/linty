// Read-only macOS capability probe for correction capture.
// Usage: swift scripts/probe-correction-accessibility.swift [bundle-id-or-pid] [seconds]
// Prints roles, supported attributes, text lengths and notification counts.
// Never prints text, window titles, selections or keystrokes; never changes focus,
// clipboard contents, accessibility settings or the target application's text.
import AppKit
import ApplicationServices

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--help" {
    print("Usage: swift scripts/probe-correction-accessibility.swift [bundle-id-or-pid] [seconds: 0...15]")
    exit(0)
}
let duration = min(15, max(0, arguments.count > 1 ? Double(arguments[1]) ?? 3 : 3))
let target = arguments.first.flatMap { bundle -> NSRunningApplication? in
    if let pid = Int32(bundle) { return NSRunningApplication(processIdentifier: pid) }
    return NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
        .first(where: { $0.isActive })
        ?? NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first
} ?? (arguments.isEmpty ? NSWorkspace.shared.frontmostApplication : nil)
guard let target else {
    fputs("Target application is not running.\n", stderr)
    exit(1)
}
guard AXIsProcessTrusted() else {
    fputs("This process has no Accessibility access; no permission prompt was requested.\n", stderr)
    exit(2)
}

let began = Date()
let application = AXUIElementCreateApplication(target.processIdentifier)
let system = AXUIElementCreateSystemWide()
AXUIElementSetMessagingTimeout(system, 0.2)

func read(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var result: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &result)
    return (error, result)
}

func elementValue(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func names(_ element: AXUIElement, parameterized: Bool = false) -> [String] {
    var result: CFArray?
    if parameterized {
        AXUIElementCopyParameterizedAttributeNames(element, &result)
    } else {
        AXUIElementCopyAttributeNames(element, &result)
    }
    return result as? [String] ?? []
}

// AX role strings are framework metadata; arbitrary application values are omitted.
func role(_ element: AXUIElement, _ attribute: String) -> String {
    let value = read(element, attribute).1 as? String ?? "unavailable"
    return value.hasPrefix("AX") && value.count < 80 ? value : "unavailable"
}

var roots: [(String, AXUIElement)] = []
for attribute in ["AXFocusedUIElement", "AXFocusedWindow"] {
    if let element = elementValue(read(application, attribute).1) {
        roots.append((attribute, element))
    }
}
if roots.isEmpty {
    let windows = read(application, "AXWindows").1 as? [AXUIElement] ?? []
    roots.append(contentsOf: windows.prefix(8).map { ("AXWindows", $0) })
}
// Hit testing exercises a separate discovery path used by some custom views.
let eventLocation = CGEvent(source: nil)?.location ?? .zero
var hit: AXUIElement?
if AXUIElementCopyElementAtPosition(system, Float(eventLocation.x), Float(eventLocation.y), &hit) == .success,
   let hit {
    var hitPID: pid_t = 0
    if AXUIElementGetPid(hit, &hitPID) == .success, hitPID == target.processIdentifier {
        roots.append(("pointerHitTest", hit))
    }
}

var elements: [AXUIElement] = []
var records: [[String: Any]] = []
var queue = roots.map { ($0.0, $0.1, 0) }
var next = 0
while next < queue.count, elements.count < 80, Date().timeIntervalSince(began) < 8 {
    let (origin, element, depth) = queue[next]
    next += 1
    if elements.contains(where: { CFEqual($0, element) }) { continue }
    elements.append(element)
    let supported = names(element)
    let subrole = role(element, "AXSubrole")
    var record: [String: Any] = [
        "index": elements.count - 1, "origin": origin, "depth": depth,
        "role": role(element, "AXRole"), "subrole": subrole,
        "textAttributes": supported.filter {
            $0.contains("Text") || $0.contains("Character") || $0 == "AXValue"
        }.sorted(),
        "parameterizedTextAttributes": names(element, parameterized: true).filter {
            $0.contains("String") || $0.contains("Text") || $0.contains("Range")
        }.sorted()
    ]
    if subrole != "AXSecureTextField" {
        let (error, value) = read(element, "AXValue")
        record["valueError"] = error.rawValue
        if let text = value as? String { record["valueUTF16Length"] = text.utf16.count }
    } else {
        record["secureFieldSkipped"] = true
    }
    if depth < 7 {
        for attribute in ["AXChildren", "AXContents", "AXVisibleChildren"] {
            let children = read(element, attribute).1 as? [AXUIElement] ?? []
            record[attribute + "Count"] = children.count
            queue.append(contentsOf: children.prefix(80).map { (attribute, $0, depth + 1) })
        }
    }
    records.append(record)
}

final class Counts {
    var events: [String: Int] = [:]
}
let counts = Counts()
var observer: AXObserver?
let createError = AXObserverCreate(target.processIdentifier, { _, _, name, context in
    guard let context else { return }
    let counts = Unmanaged<Counts>.fromOpaque(context).takeUnretainedValue()
    counts.events[name as String, default: 0] += 1
}, &observer)
var subscriptions: [[String: Any]] = []
var registered: [(AXUIElement, String)] = []
if let observer {
    let context = Unmanaged.passUnretained(counts).toOpaque()
    func subscribe(_ element: AXUIElement, _ name: String, _ index: Int) {
        let error = AXObserverAddNotification(observer, element, name as CFString, context)
        subscriptions.append(["element": index, "notification": name, "error": error.rawValue])
        if error == .success { registered.append((element, name)) }
    }
    subscribe(application, "AXFocusedUIElementChanged", -1)
    for (index, element) in elements.enumerated() {
        let r = role(element, "AXRole")
        if ["AXTextField", "AXTextArea", "AXComboBox"].contains(r), role(element, "AXSubrole") != "AXSecureTextField" {
            subscribe(element, "AXValueChanged", index)
            subscribe(element, "AXSelectedTextChanged", index)
            subscribe(element, "AXUIElementDestroyed", index)
        }
    }
    let source = AXObserverGetRunLoopSource(observer)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
    if duration > 0 { RunLoop.current.run(until: Date().addingTimeInterval(duration)) }
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode)
    for (element, name) in registered {
        AXObserverRemoveNotification(observer, element, name as CFString)
    }
}
let capabilities = ["AXManualAccessibility", "AXEnhancedUserInterface"].map { name -> [String: Any] in
    var settable = DarwinBoolean(false)
    let error = AXUIElementIsAttributeSettable(application, name as CFString, &settable)
    return ["attribute": name, "settable": settable.boolValue, "error": error.rawValue]
}
let report: [String: Any] = [
    "bundleId": target.bundleIdentifier ?? "unknown", "pid": target.processIdentifier,
    "trusted": true, "elapsedSeconds": Date().timeIntervalSince(began),
    "elements": records, "truncated": next < queue.count,
    "observerCreateError": createError.rawValue,
    "subscriptions": subscriptions, "eventCounts": counts.events,
    "activationCapabilities": capabilities,
    "note": "Capability snapshot only. Successful registration does not prove event delivery. No text content or keystrokes are logged."
]
let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
print(String(decoding: data, as: UTF8.self))
