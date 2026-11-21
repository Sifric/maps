import CoreLocation
import Foundation

@MainActor
public final class SifricNavigation {
    public enum Event {
        case route(SifricRoute, rerouted: Bool)
        case progress(remainingMeters: Double, nextManeuver: SifricRoute.Maneuver?)
        case arrived
        case error(String)
    }

    private let client: SifricClient
    private let onEvent: (Event) -> Void
    private var destination: CLLocationCoordinate2D?
    private var mode = "drive"
    private var request: Task<Void, Never>?
    private var plan: Plan?
    private var progress = 0.0
    private var offRoute = 0
    private var lastFix = Date.distantPast
    private var lastReroute = Date.distantPast

    public init(client: SifricClient, onEvent: @escaping (Event) -> Void) {
        self.client = client
        self.onEvent = onEvent
    }

    public func start(destination: CLLocationCoordinate2D, mode: String = "drive") throws {
        guard (78...82.5).contains(destination.longitude), (5...10.5).contains(destination.latitude),
              ["drive", "walk", "cycle"].contains(mode) else { throw SifricError.invalidCoordinates }
        stop()
        self.destination = destination
        self.mode = mode
        lastFix = .distantPast
        lastReroute = .distantPast
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
            onEvent(.arrived)
        } else {
            let next = plan.turns.first { $0.along > progress + 5 }?.maneuver
            onEvent(.progress(remainingMeters: remaining, nextManeuver: next))
        }
    }

    public func stop() {
        request?.cancel()
        request = nil
        destination = nil
        plan = nil
        progress = 0
        offRoute = 0
    }

    private func makeRoute(from origin: [Double], to destination: CLLocationCoordinate2D, rerouting: Bool) {
        let target = [destination.longitude, destination.latitude]
        let profile = mode
        request = Task { [weak self] in
            guard let self else { return }
            do {
                let route = try await client.route(coordinates: [origin, target], mode: profile)
                try Task.checkCancellation()
                plan = try Plan(route)
                progress = 0
                offRoute = 0
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
    }

    let length: Double
    let end: [Double]
    let segments: [Segment]
    var turns: [(along: Double, maneuver: SifricRoute.Maneuver)] = []

    init(_ route: SifricRoute) throws {
        let coordinates = route.geometry.coordinates
        guard coordinates.count >= 2 && coordinates.count <= 40_000,
              coordinates.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isFinite) }),
              let end = coordinates.last else { throw SifricError.invalidResponse }
        self.end = end
        var total = 0.0
        var segments: [Segment] = []
        for (a, b) in zip(coordinates, coordinates.dropFirst()) {
            let x = (b[0] - a[0]) * Self.longitudeScale(a[1])
            let y = (b[1] - a[1]) * 111_195
            let length = hypot(x, y)
            guard length > 0 else { continue }
            segments.append(Segment(a: a, x: x, y: y, length: length, start: total))
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

    func project(_ point: [Double], reference: Double) -> (along: Double, away: Double) {
        var cost = Double.infinity
        var best = (along: 0.0, away: Double.infinity)
        for segment in segments {
            let x = (point[0] - segment.a[0]) * Self.longitudeScale(segment.a[1])
            let y = (point[1] - segment.a[1]) * 111_195
            let t = max(0, min(1, (x * segment.x + y * segment.y) / (segment.length * segment.length)))
            let along = segment.start + t * segment.length
            let away = hypot(x - t * segment.x, y - t * segment.y)
            let next = away + min(25, abs(along - reference) / 200)
            if next < cost {
                best = (along, away)
                cost = next
            }
        }
        return best
    }
}
