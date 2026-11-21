import Foundation

public struct SifricPlace: Codable, Identifiable, Sendable {
    public let id: Int64
    public let name: String
    public let lon: Double
    public let lat: Double
    public let kind: String
    public let description: String
    public let label: String?
}

public struct SifricPlacePhoto: Codable, Sendable {
    public let title: String
    public let thumbnailUrl: URL
    public let sourcePage: URL
    public let author: String?
    public let license: String
    public let licenseUrl: URL?
}

public struct SifricRoute: Codable, Sendable {
    public struct Geometry: Codable, Sendable {
        public let type: String
        public let coordinates: [[Double]]
    }

    public struct Maneuver: Codable, Sendable {
        public let type: String
        public let location: [Double]
        public let modifier: String?
        public let exit: Int?
    }

    public struct Step: Codable, Sendable {
        public let name: String
        public let maneuver: Maneuver
    }

    public struct Leg: Codable, Sendable {
        public let distance: Double
        public let duration: Double
        public let steps: [Step]
        public let speedLimits: [SpeedLimit]?
    }

    public struct SpeedLimit: Codable, Sendable {
        public let startIndex: Int
        public let endIndex: Int
        public let speed: Double?
        public let unit: String?
    }

    public let distance: Double
    public let duration: Double
    public let geometry: Geometry
    public let legs: [Leg]
    public let trafficDuration: Double?
    public let matchedTrafficSegments: Int?
}

public struct SifricRouteOptions: Encodable, Sendable {
    public var alternatives: Bool?
    public var optimizeWaypointOrder: Bool?
    public var avoidTolls: Bool?
    public var avoidHighways: Bool?
    public var avoidFerries: Bool?
    public var speedLimits: Bool?
    public var trafficAware: Bool?

    public init() {}
}

public struct SifricRouteChoices: Decodable, Sendable {
    public let routes: [SifricRoute]
    public let optimizedIntermediateWaypointIndices: [Int]?
}

public enum SifricError: LocalizedError, Sendable {
    case authenticationRequired
    case invalidResponse
    case invalidCoordinates
    case http(Int, String)

    public var errorDescription: String? {
        switch self {
        case .authenticationRequired: return "Sifric developer access is required."
        case .invalidResponse: return "Sifric returned an invalid response."
        case .invalidCoordinates: return "Choose valid coordinates in Sri Lanka."
        case .http(_, let message): return message
        }
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public final class SifricClient: Sendable {
    private struct Places: Decodable { let items: [SifricPlace] }
    private struct Photos: Decodable { let items: [SifricPlacePhoto] }
    private struct ErrorResponse: Decodable { let error: String }
    private let credentialProvider: @Sendable () async throws -> String
    private let session: URLSession

    public init(credentialProvider: @escaping @Sendable () async throws -> String) {
        self.credentialProvider = credentialProvider
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 65
        session = URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    public func search(_ query: String) async throws -> [SifricPlace] {
        let data = try await request("places/search", query: [URLQueryItem(name: "q", value: query)])
        return try JSONDecoder().decode(Places.self, from: data).items
    }

    public func nearby(longitude: Double, latitude: Double, radiusMeters: Int = 2_000) async throws -> [SifricPlace] {
        let data = try await request("places/nearby", query: [
            URLQueryItem(name: "lon", value: String(longitude)),
            URLQueryItem(name: "lat", value: String(latitude)),
            URLQueryItem(name: "radius", value: String(radiusMeters))
        ])
        return try JSONDecoder().decode(Places.self, from: data).items
    }

    public func details(id: Int64) async throws -> SifricPlace {
        try JSONDecoder().decode(SifricPlace.self, from: await request("places/\(id)"))
    }

    public func photos(placeId: Int64) async throws -> [SifricPlacePhoto] {
        let data = try await request("places/\(placeId)/photos")
        return try JSONDecoder().decode(Photos.self, from: data).items
    }

    public func route(coordinates: [[Double]], mode: String = "drive", trafficAware: Bool = false) async throws -> SifricRoute {
        var options = SifricRouteOptions()
        if trafficAware { options.trafficAware = true }
        let result = try await routes(coordinates: coordinates, mode: mode, options: options)
        guard let first = result.routes.first else {
            throw SifricError.invalidResponse
        }
        return first
    }

    public func routes(coordinates: [[Double]], mode: String = "drive",
                       options: SifricRouteOptions = .init()) async throws -> SifricRouteChoices {
        struct Request: Encodable {
            let coordinates: [[Double]]
            let mode: String
            let options: SifricRouteOptions

            enum CodingKeys: String, CodingKey { case coordinates, mode }

            func encode(to encoder: Encoder) throws {
                try options.encode(to: encoder)
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(coordinates, forKey: .coordinates)
                try container.encode(mode, forKey: .mode)
            }
        }
        let body = try JSONEncoder().encode(Request(coordinates: coordinates, mode: mode, options: options))
        return try JSONDecoder().decode(SifricRouteChoices.self, from: await request("routes", body: body))
    }

    public func matrix(json: Data) async throws -> Data { try await request("matrix", body: json) }
    public func matchTrace(json: Data) async throws -> Data { try await request("roads/match", body: json) }
    public func optimizeFleet(json: Data) async throws -> Data { try await request("optimize", body: json) }
    public func validateAddress(json: Data) async throws -> Data { try await request("address/validate", body: json) }
    public func locateByCell(json: Data) async throws -> Data { try await request("geolocate", body: json) }
    public func locate(json: Data) async throws -> Data { try await request("geolocate", body: json) }
    public func transitRoute(json: Data) async throws -> Data { try await request("transit/routes", body: json) }

    private func request(_ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        let token = try await credentialProvider()
        guard token.range(of: "^[A-Za-z0-9_-]{43,128}$", options: .regularExpression) != nil else {
            throw SifricError.authenticationRequired
        }
        var location = URLComponents()
        location.scheme = "https"
        location.host = "maps.sifric.workers.dev"
        location.path = "/developer/api/v1/" + path
        if !query.isEmpty { location.queryItems = query }
        guard let url = location.url else { throw SifricError.invalidResponse }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw SifricError.invalidResponse }
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).error) ?? "Sifric API returned HTTP \(status)."
            throw SifricError.http(status, message)
        }
        return data
    }
}
