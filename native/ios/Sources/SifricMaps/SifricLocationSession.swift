import CoreLocation
import Foundation

/// Retain the session while navigating. Enable the Location updates capability for background use.
@MainActor
public final class SifricLocationSession: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let client: SifricClient
    private let onEvent: (SifricNavigation.Event) -> Void
    private var active = false
    private var routeReady = false
    private lazy var navigation = SifricNavigation(client: client) { [weak self] event in
        guard let self else { return }
        switch event {
        case .route: routeReady = true
        case .error where !routeReady: stop()
        case .arrived:
            active = false
            manager.stopUpdatingLocation()
            manager.allowsBackgroundLocationUpdates = false
        default: break
        }
        onEvent(event)
    }

    public init(client: SifricClient, onEvent: @escaping (SifricNavigation.Event) -> Void) {
        self.client = client
        self.onEvent = onEvent
        super.init()
        manager.delegate = self
        manager.activityType = .automotiveNavigation
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.pausesLocationUpdatesAutomatically = false
    }

    public func start(destination: CLLocationCoordinate2D, mode: String = "drive",
                      background: Bool = false, voice: Bool = true) throws {
        if background && !(Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []).contains("location") {
            throw SifricError.http(400, "Enable the Location updates background capability.")
        }
        guard Bundle.main.object(forInfoDictionaryKey: "NSLocationWhenInUseUsageDescription") != nil else {
            throw SifricError.http(400, "Add a location usage description to the host app.")
        }
        try navigation.start(destination: destination, mode: mode)
        active = true
        routeReady = false
        navigation.voiceEnabled = voice
        manager.allowsBackgroundLocationUpdates = background
        manager.showsBackgroundLocationIndicator = background
        updateAuthorization(manager.authorizationStatus)
    }

    public func stop() {
        active = false
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        navigation.stop()
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if active { updateAuthorization(manager.authorizationStatus) }
    }

    private func updateAuthorization(_ status: CLAuthorizationStatus) {
        switch status {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways: manager.startUpdatingLocation()
        default:
            stop()
            onEvent(.error("Grant location access to start navigation."))
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if active, let location = locations.last { navigation.update(location: location) }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if active, (error as? CLError)?.code != .locationUnknown { onEvent(.error(error.localizedDescription)) }
    }
}
