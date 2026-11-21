import CoreLocation
import Foundation

public enum SifricMapsURLs {
    private static let host = "maps.sifric.workers.dev"

    public static func search(_ query: String) -> URL {
        url("/developer/", [URLQueryItem(name: "q", value: query)])
    }

    public static func pin(_ point: CLLocationCoordinate2D, zoom: Double = 15) throws -> URL {
        guard CLLocationCoordinate2DIsValid(point), (0...20).contains(zoom) else { throw SifricError.invalidCoordinates }
        return url("/developer/embed/", [
            URLQueryItem(name: "lon", value: String(point.longitude)),
            URLQueryItem(name: "lat", value: String(point.latitude)),
            URLQueryItem(name: "zoom", value: String(zoom)),
            URLQueryItem(name: "pin", value: "1")
        ])
    }

    public static func directions(from origin: CLLocationCoordinate2D, to destination: CLLocationCoordinate2D,
                                  mode: String = "drive") throws -> URL {
        guard CLLocationCoordinate2DIsValid(origin), CLLocationCoordinate2DIsValid(destination),
              ["drive", "walk", "cycle", "motorcycle", "tuk"].contains(mode) else { throw SifricError.invalidCoordinates }
        return url("/developer/navigation/", [
            URLQueryItem(name: "origin", value: "\(origin.longitude),\(origin.latitude)"),
            URLQueryItem(name: "destination", value: "\(destination.longitude),\(destination.latitude)"),
            URLQueryItem(name: "mode", value: mode)
        ])
    }

    public static func handles(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "https", components.host == host, components.port == nil,
              components.user == nil, components.password == nil else { return false }
        return ["/developer/", "/developer/embed/", "/developer/navigation/"].contains(components.path)
    }

    private static func url(_ path: String, _ items: [URLQueryItem]) -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = path
        components.queryItems = items
        return components.url!
    }
}
