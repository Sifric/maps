import CoreLocation
import AVFoundation
import Foundation

@MainActor
public final class SifricNavigation {
    public enum Event {
        case route(SifricRoute, rerouted: Bool)
        case progress(remainingMeters: Double, nextManeuver: SifricRoute.Maneuver?)
        case arrived
        case error(String)
    }

    public struct Progress {
        public let remainingSeconds: Double
        public let speedKph: Double?
        public let speedLimitKph: Double?
        public var isOverSpeedLimit: Bool {
            guard let speedKph, let speedLimitKph else { return false }
            return speedKph > speedLimitKph
        }
    }

    public private(set) var metrics: Progress?
    private let client: SifricClient
    private let onEvent: (Event) -> Void
    private var destination: CLLocationCoordinate2D?
    private var mode = "drive"
    private var routeOptions = SifricRouteOptions()
    private var request: Task<Void, Never>?
    private var plan: Plan?
    private var progress = 0.0
    private var offRoute = 0
    private var lastFix = Date.distantPast
    private var lastReroute = Date.distantPast
    private let speech = AVSpeechSynthesizer()
    public var voiceEnabled = false
    private var spokenPosition: Double?

    private func speak(_ text: String) {
        guard voiceEnabled else { return }
        speech.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en")
        speech.speak(utterance)
    }

    public init(client: SifricClient, onEvent: @escaping (Event) -> Void) {
        self.client = client
        self.onEvent = onEvent
    }

    public func start(destination: CLLocationCoordinate2D, mode: String = "drive") throws {
        try start(destination: destination, mode: mode, options: .init())
    }

    public func start(destination: CLLocationCoordinate2D, mode: String = "drive",
                      options: SifricRouteOptions, initialRoute: SifricRoute? = nil) throws {
        guard (78...82.5).contains(destination.longitude), (5...10.5).contains(destination.latitude),
              ["drive", "walk", "cycle", "motorcycle", "tuk"].contains(mode) else { throw SifricError.invalidCoordinates }
        let initialPlan = try initialRoute.map { try Plan($0) }
        stop()
        self.destination = destination
        self.mode = mode
        routeOptions = options
        routeOptions.optimizeWaypointOrder = nil
        routeOptions.alternatives = nil
        self.plan = initialPlan
        lastFix = .distantPast
        lastReroute = .distantPast
        if let initialRoute { onEvent(.route(initialRoute, rerouted: false)) }
    }

    public func update(location: CLLocation) {
        guard let destination, request == nil,
              (0...70).contains(location.horizontalAccuracy), location.timestamp > lastFix,
              CLLocationCoordinate2DIsValid(location.coordinate) else { return }
        lastFix = location.timestamp
        let point = [location.coordinate.longitude, location.coordinate.latitude]
        guard let plan else {
            makeRoute(from: point, to: destination, rerouting: false)
            return
        }
        let match = plan.project(point, reference: progress)
        if match.away > max(35, location.horizontalAccuracy * 1.5) {
            metrics = nil
            offRoute += 1
            if offRoute >= 3 && lastFix.timeIntervalSince(lastReroute) >= 15 {
                lastReroute = lastFix
                makeRoute(from: point, to: destination, rerouting: true)
            }
            return
        }
        offRoute = 0
        progress = max(progress, match.along)
        let remaining = plan.length - progress
        if remaining <= 25 && Plan.distance(point, plan.end) <= 25 && location.horizontalAccuracy <= 25 {
            stop()
            speak("You have arrived.")
            onEvent(.arrived)
        } else {
            metrics = Progress(remainingSeconds: plan.duration * remaining / plan.length,
                               speedKph: location.speed.isFinite && location.speed >= 0 ? location.speed * 3.6 : nil,
                               speedLimitKph: plan.speedLimit(segment: match.index))
            let next = plan.turns.first { $0.along > progress + 5 }
            if let next, voiceEnabled, next.along - progress <= 120,
               next.along != spokenPosition, next.maneuver.type != "arrive" {
                spokenPosition = next.along
                switch next.maneuver.modifier {
                case "uturn": speak("Make a U-turn.")
                case "straight", nil: speak("Continue straight.")
                case let direction?: speak("Turn \(direction).")
                }
            }
            onEvent(.progress(remainingMeters: remaining, nextManeuver: next?.maneuver))
        }
    }

    public func stop() {
        request?.cancel()
        request = nil
        destination = nil
        plan = nil
        metrics = nil
        progress = 0
        offRoute = 0
        spokenPosition = nil
        speech.stopSpeaking(at: .immediate)
    }

    private func makeRoute(from origin: [Double], to destination: CLLocationCoordinate2D, rerouting: Bool) {
        let target = [destination.longitude, destination.latitude]
        let profile = mode
        let options = routeOptions
        request = Task { [weak self] in
            guard let self else { return }
            do {
                let choices = try await client.routes(coordinates: [origin, target], mode: profile, options: options)
                guard let route = choices.routes.first else { throw SifricError.invalidResponse }
                try Task.checkCancellation()
                plan = try Plan(route)
                progress = 0
                offRoute = 0
                spokenPosition = nil
                request = nil
                onEvent(.route(route, rerouted: rerouting))
            } catch {
                if Task.isCancelled { return }
                request = nil
                if !rerouting { stop() }
                onEvent(.error(error.localizedDescription))
            }
        }
    }
}

private struct Plan {
    struct Segment {
        let a: [Double]
        let x: Double
        let y: Double
        let length: Double
        let start: Double
        let index: Int
    }

    let length: Double
    let duration: Double
    let limits: [SifricRoute.SpeedLimit]
    let end: [Double]
    let segments: [Segment]
    var turns: [(along: Double, maneuver: SifricRoute.Maneuver)] = []

    init(_ route: SifricRoute) throws {
        let coordinates = route.geometry.coordinates
        guard coordinates.count >= 2 && coordinates.count <= 40_000,
              coordinates.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isFinite) }),
              let end = coordinates.last else { throw SifricError.invalidResponse }
        self.end = end
        duration = route.trafficDuration ?? route.duration
        limits = route.legs.flatMap { $0.speedLimits ?? [] }
        var total = 0.0
        var segments: [Segment] = []
        for (index, (a, b)) in zip(coordinates, coordinates.dropFirst()).enumerated() {
            let x = (b[0] - a[0]) * Self.longitudeScale(a[1])
            let y = (b[1] - a[1]) * 111_195
            let length = hypot(x, y)
            guard length > 0 else { continue }
            segments.append(Segment(a: a, x: x, y: y, length: length, start: total, index: index))
            total += length
        }
        guard total > 0 else { throw SifricError.invalidResponse }
        length = total
        self.segments = segments
        var along = 0.0
        for leg in route.legs {
            for step in leg.steps where step.maneuver.type != "depart" && step.maneuver.location.count == 2 {
                along = max(along, project(step.maneuver.location, reference: along).along)
                turns.append((along, step.maneuver))
            }
        }
    }

    static func longitudeScale(_ latitude: Double) -> Double { 111_195 * cos(latitude * .pi / 180) }
    static func distance(_ a: [Double], _ b: [Double]) -> Double {
        hypot((b[0] - a[0]) * longitudeScale(a[1]), (b[1] - a[1]) * 111_195)
    }

    func speedLimit(segment: Int) -> Double? {
        guard let span = limits.first(where: { $0.startIndex <= segment && segment < $0.endIndex }),
              let speed = span.speed, speed > 0 else { return nil }
        switch span.unit {
        case "km/h": return speed
        case "mph": return speed * 1.609344
        default: return nil
        }
    }

    func project(_ point: [Double], reference: Double) -> (along: Double, away: Double, index: Int) {
        var cost = Double.infinity
        var best = (along: 0.0, away: Double.infinity, index: 0)
        for segment in segments {
            let x = (point[0] - segment.a[0]) * Self.longitudeScale(segment.a[1])
            let y = (point[1] - segment.a[1]) * 111_195
            let t = max(0, min(1, (x * segment.x + y * segment.y) / (segment.length * segment.length)))
            let along = segment.start + t * segment.length
            let away = hypot(x - t * segment.x, y - t * segment.y)
            let next = away + min(25, abs(along - reference) / 200)
            if next < cost {
                best = (along, away, segment.index)
                cost = next
            }
        }
        return best
    }
}
