#include <routingkit/contraction_hierarchy.h>
#include <routingkit/osm_graph_builder.h>
#include <routingkit/osm_profile.h>
#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string_view>
#include <unordered_map>
#include <vector>

using namespace RoutingKit;
constexpr unsigned no_arc = UINT32_MAX;

template<class T>
void write_column(std::ostream& out, const std::vector<T>& values) {
    uint32_t count = values.size();
    out.write(reinterpret_cast<const char*>(&count), sizeof(count));
    out.write(reinterpret_cast<const char*>(values.data()), sizeof(T) * values.size());
}

void write_side(std::ostream& out, const ContractionHierarchy::Side& side) {
    write_column(out, side.first_out);
    write_column(out, side.head);
    write_column(out, side.weight);
    auto second = side.shortcut_second_arc;
    for (unsigned i = 0; i < second.size(); ++i) {
        if (side.is_shortcut_an_original_arc.is_set(i)) second[i] = no_arc;
    }
    write_column(out, side.shortcut_first_arc);
    write_column(out, second);
}

uint16_t posted_limit(const TagMap& tags, const char* direction, const char* conditional) {
    if (tags[conditional] || tags["maxspeed:conditional"]) return 0;
    const char* value = tags[direction];
    if (!value) value = tags["maxspeed"];
    if (!value) return 0;
    std::string raw(value);
    auto end = raw.find_first_not_of("0123456789");
    auto digits = raw.substr(0, end);
    if (digits.empty() || digits.size() > 3) return 0;
    auto units = end == std::string::npos ? "" : raw.substr(end);
    if (units != "" && units != " km/h" && units != " mph") return 0;
    auto amount = std::stoi(digits);
    if (amount < 1 || amount > 160) return 0;
    return static_cast<uint16_t>(amount | (units == " mph" ? 0x8000 : 0));
}

std::string_view tag(const TagMap& tags, const char* key) {
    const char* value = tags[key];
    return value ? value : "";
}

bool restricted(std::string_view access) {
    return access == "no" || access == "private" || access == "customers" || access == "permit" ||
        access == "delivery" || access == "agricultural" || access == "forestry" || access == "use_sidepath";
}

bool listed(std::string_view values, std::string_view expected) {
    while (!values.empty()) {
        const auto delimiter = values.find(';');
        auto value = values.substr(0, delimiter);
        const auto start = value.find_first_not_of(" \t");
        if (start != std::string_view::npos &&
            value.substr(start, value.find_last_not_of(" \t") - start + 1) == expected) return true;
        if (delimiter == std::string_view::npos) break;
        values.remove_prefix(delimiter + 1);
    }
    return false;
}

unsigned surface_speed(const TagMap& tags, unsigned speed, bool car, bool cycle) {
    const auto surface = tag(tags, "surface");
    const auto smoothness = tag(tags, "smoothness");
    if (!car && tag(tags, "highway") == "steps") return cycle ? 4 : 3;
    if (surface == "sand" || surface == "mud" || smoothness == "very_bad" ||
        smoothness == "horrible" || smoothness == "very_horrible" || smoothness == "impassable") {
        return std::min(speed, car ? 12u : cycle ? 6u : 4u);
    }
    if (surface == "unpaved" || surface == "gravel" || surface == "fine_gravel" || surface == "ground" ||
        surface == "dirt" || surface == "earth" || surface == "compacted" || smoothness == "bad") {
        return std::min(speed, car ? 30u : cycle ? 11u : 5u);
    }
    return speed;
}

int main(int argc, char** argv) {
    if (argc != 4) {
        std::cerr << "Usage: build-routing-graph INPUT.osm.pbf OUTPUT.bin MODE\n";
        return 1;
    }
    const std::string mode = argv[3];
    const bool avoid_tolls = mode == "drive-no-tolls";
    const bool avoid_highways = mode == "drive-no-highways" || avoid_tolls;
    const bool drive = mode == "drive" || avoid_highways;
    const bool motorcycle = mode == "motorcycle";
    const bool tuk = mode == "tuk";
    const bool car = drive || motorcycle || tuk;
    const bool cycle = mode == "cycle";
    if (!car && !cycle && mode != "walk") return 1;
    auto log = [](const std::string& msg) { std::cerr << msg << '\n'; };
    auto mapping = load_osm_id_mapping_from_pbf(argv[1], nullptr,
        [&](uint64_t id, const TagMap& tags) {
            const auto highway = tag(tags, "highway");
            if (highway.empty() || highway == "construction" || highway == "proposed" || highway == "ferry" ||
                tag(tags, "route") == "ferry" || tag(tags, "ferry") == "yes" || tag(tags, "area") == "yes") return false;
            if ((car || cycle) && tag(tags, "smoothness") == "impassable") return false;
            if (avoid_highways && (highway == "motorway" || highway == "motorway_link")) return false;
            if (avoid_tolls) {
                auto toll = tag(tags, "toll:motorcar");
                if (toll.empty()) toll = tag(tags, "toll:motor_vehicle");
                if (toll.empty()) toll = tag(tags, "toll");
                if ((!toll.empty() && toll != "no") || tags["toll:conditional"] ||
                    tags["toll:motorcar:conditional"] || tags["toll:motor_vehicle:conditional"]) return false;
            }
            auto access = tag(tags, car ? (motorcycle ? "motorcycle" : drive ? "motorcar" : "motor_vehicle") :
                cycle ? "bicycle" : "foot");
            if (access.empty() && car) access = tag(tags, "motor_vehicle");
            if (access.empty() && (car || cycle)) access = tag(tags, "vehicle");
            if (access.empty()) access = tag(tags, "access");
            if (restricted(access)) return false;
            if (car) {
                if (!drive) {
                    const auto motorroad = tag(tags, "motorroad");
                    if (highway == "motorway" || highway == "motorway_link" || motorroad == "yes") return false;
                    const char* tag = motorcycle ? tags["motorcycle"] : nullptr;
                    if (tag && (std::string(tag) == "no" || std::string(tag) == "private")) return false;
                }
                const auto vehicle = tag(tags, "motor_vehicle");
                const auto motorcar = tag(tags, "motorcar");
                if (vehicle == "private" || motorcar == "private" || motorcar == "no") return false;
                return is_osm_way_used_by_cars(id, tags);
            }
            const std::string motorroad = tags["motorroad"] ? tags["motorroad"] : "";
            if (motorroad == "yes" || highway == "motorway" || highway == "motorway_link") return false;
            if (cycle) return is_osm_way_used_by_bicycles(id, tags);
            const std::string foot = tags["foot"] ? tags["foot"] : "";
            const std::string sidewalk = tags["sidewalk"] ? tags["sidewalk"] : "";
            if (foot == "no" || foot == "private" || foot == "use_sidepath") return false;
            if ((highway == "primary" || highway == "primary_link") &&
                sidewalk != "separate" && (access.empty() || access == "yes" || access == "permissive")) return true;
            return is_osm_way_used_by_pedestrians(id, tags);
        }, log, false);
    std::vector<unsigned> forward_speed(mapping.is_routing_way.population_count()), backward_speed(forward_speed.size());
    std::vector<uint16_t> posted_forward(drive ? forward_speed.size() : 0), posted_backward(drive ? forward_speed.size() : 0);
    TagMap restriction_tags;
    auto graph = load_osm_routing_graph_from_pbf(argv[1], mapping,
        [&](uint64_t id, unsigned way, const TagMap& tags) {
            const unsigned top_speed = tuk ? 40 : motorcycle ? 80 : 130;
            const auto nominal = car ? std::clamp(get_osm_way_speed(id, tags), 1u, top_speed) : cycle ? 16u : 5u;
            forward_speed[way] = backward_speed[way] = surface_speed(tags, nominal, car, cycle);
            if (car) {
                const auto forward = posted_limit(tags, "maxspeed:forward", "maxspeed:forward:conditional");
                const auto backward = posted_limit(tags, "maxspeed:backward", "maxspeed:backward:conditional");
                const auto cap = [](unsigned speed, uint16_t limit) {
                    if (!limit) return speed;
                    const unsigned value = limit & 0x7fff;
                    return std::min(speed, limit & 0x8000 ? value * 1609 / 1000 : value);
                };
                forward_speed[way] = cap(forward_speed[way], forward);
                backward_speed[way] = cap(backward_speed[way], backward);
                if (drive) {
                    posted_forward[way] = forward;
                    posted_backward[way] = backward;
                }
                return get_osm_car_direction_category(id, tags);
            }
            if (cycle) return get_osm_bicycle_direction_category(id, tags);
            return OSMWayDirectionCategory::open_in_both;
        },
        [&](uint64_t id, const std::vector<OSMRelationMember>& members, const TagMap& tags,
            std::function<void(OSMTurnRestriction)> emit) {
            if (!car && !cycle) return;
            const char* restriction = tags[cycle ? "restriction:bicycle" :
                motorcycle ? "restriction:motorcycle" : drive ? "restriction:motorcar" : "restriction:motor_vehicle"];
            if (!restriction && car) restriction = tags["restriction:motor_vehicle"];
            if (!restriction) restriction = tags["restriction:vehicle"];
            if (!restriction) {
                const auto exceptions = tag(tags, "except");
                if (listed(exceptions, "vehicle") || (car && listed(exceptions, "motor_vehicle")) ||
                    (drive && listed(exceptions, "motorcar")) || (cycle && listed(exceptions, "bicycle")) ||
                    (motorcycle && listed(exceptions, "motorcycle"))) return;
                restriction = tags["restriction"];
            }
            if (!restriction) return;
            restriction_tags.build(1, [](unsigned) { return "restriction"; }, [&](unsigned) { return restriction; });
            decode_osm_car_turn_restrictions(id, members, restriction_tags, emit);
        }, log, true, OSMRoadGeometry::uncompressed);
    mapping = OSMRoutingIDMapping();

    unsigned state_count = graph.node_count();
    std::map<unsigned, std::vector<unsigned>> forbidden;
    for (unsigned i = 0; i < graph.forbidden_turn_from_arc.size(); ++i) {
        forbidden[graph.forbidden_turn_from_arc[i]].push_back(graph.forbidden_turn_to_arc[i]);
    }
    std::unordered_map<unsigned, unsigned> arrivals, terminals;
    for (const auto& [arc, restrictions] : forbidden) {
        arrivals[arc] = state_count++;
        unsigned node = graph.head[arc];
        if (!terminals.count(node)) terminals[node] = state_count++;
    }

    std::vector<unsigned> tails, heads, weights, transition_arc, arc_tails, travel_time;
    auto add = [&](unsigned from, unsigned to, unsigned time, unsigned arc) {
        tails.push_back(from);
        heads.push_back(to);
        weights.push_back(time);
        transition_arc.push_back(arc);
    };
    for (unsigned from = 0; from < graph.node_count(); ++from) {
        for (unsigned arc = graph.first_out[from]; arc < graph.first_out[from + 1]; ++arc) {
            const auto& speed = graph.is_arc_antiparallel_to_way[arc] ? backward_speed : forward_speed;
            unsigned millis = std::max(1u, static_cast<unsigned>(3600.0 * graph.geo_distance[arc] / speed[graph.way[arc]]));
            arc_tails.push_back(from);
            travel_time.push_back(millis);
            add(from, arrivals.count(arc) ? arrivals.at(arc) : graph.head[arc], millis, arc);
        }
    }
    for (const auto& [arc, restrictions] : forbidden) {
        unsigned junction = graph.head[arc];
        unsigned state = arrivals.at(arc);
        add(state, terminals.at(junction), 0, no_arc);
        for (unsigned next = graph.first_out[junction]; next < graph.first_out[junction + 1]; ++next) {
            if (std::find(restrictions.begin(), restrictions.end(), next) == restrictions.end()) {
                add(state, arrivals.count(next) ? arrivals.at(next) : graph.head[next], travel_time[next], next);
            }
        }
    }

    auto hierarchy = ContractionHierarchy::build(state_count, std::move(tails), std::move(heads), std::move(weights), log);
    std::vector<unsigned> terminal_nodes, terminal_ranks;
    std::map<unsigned, unsigned> ordered_terminals(terminals.begin(), terminals.end());
    for (const auto& [node, terminal] : ordered_terminals) {
        terminal_nodes.push_back(node);
        terminal_ranks.push_back(hierarchy.rank[terminal]);
    }
    hierarchy.rank.resize(graph.node_count());

    // Small cells index the routing vertices used for snapping.
    std::vector<std::vector<unsigned>> cells(500 * 600);
    for (unsigned i = 0; i < graph.node_count(); ++i) {
        int x = static_cast<int>((graph.longitude[i] - 78) * 100);
        int y = static_cast<int>((graph.latitude[i] - 5) * 100);
        if (x >= 0 && x < 500 && y >= 0 && y < 600 && graph.longitude[i] >= 78 && graph.latitude[i] >= 5) {
            cells[y * 500 + x].push_back(i);
        }
    }
    std::vector<unsigned> cell_offsets{0}, cell_nodes;
    for (const auto& cell : cells) {
        cell_nodes.insert(cell_nodes.end(), cell.begin(), cell.end());
        cell_offsets.push_back(cell_nodes.size());
    }

    std::vector<unsigned> shape_offsets(graph.arc_count()), shape_lengths(graph.arc_count());
    std::vector<std::vector<unsigned>> shape_cells(120);
    for (unsigned arc = 0; arc < graph.arc_count(); ++arc) {
        auto from = arc_tails[arc];
        int x = std::clamp(static_cast<int>((graph.longitude[from] - 78) * 2), 0, 9);
        int y = std::clamp(static_cast<int>((graph.latitude[from] - 5) * 2), 0, 11);
        shape_cells[y * 10 + x].push_back(arc);
    }
    std::vector<unsigned> shape_boundaries{0};
    std::vector<float> shapes;
    for (const auto& cell : shape_cells) {
        for (const auto arc : cell) {
            shape_offsets[arc] = shapes.size() / 2;
            unsigned start = graph.first_modelling_node[arc];
            unsigned end = graph.first_modelling_node[arc + 1];
            shape_lengths[arc] = end - start;
            for (unsigned i = start; i < end; ++i) {
                shapes.push_back(graph.modelling_node_longitude[i]);
                shapes.push_back(graph.modelling_node_latitude[i]);
            }
        }
        shape_boundaries.push_back(shapes.size() / 2);
    }
    std::ofstream out(argv[2], std::ios::binary);
    out.write("SIFRIC02", 8);
    uint32_t core_size = 0;
    out.write(reinterpret_cast<const char*>(&core_size), sizeof(core_size));
    write_column(out, hierarchy.rank);
    write_column(out, terminal_nodes);
    write_column(out, terminal_ranks);
    write_column(out, cell_offsets);
    write_column(out, cell_nodes);
    write_column(out, graph.longitude);
    write_column(out, graph.latitude);
    write_side(out, hierarchy.forward);
    write_side(out, hierarchy.backward);
    write_column(out, transition_arc);
    write_column(out, graph.head);
    write_column(out, graph.geo_distance);
    write_column(out, shape_offsets);
    write_column(out, shape_lengths);
    write_column(out, shape_boundaries);
    core_size = out.tellp();
    out.write(reinterpret_cast<const char*>(shapes.data()), sizeof(float) * shapes.size());
    if (drive) {
        std::vector<uint16_t> limits;
        limits.reserve(graph.arc_count());
        for (unsigned arc = 0; arc < graph.arc_count(); ++arc) {
            const auto& values = graph.is_arc_antiparallel_to_way[arc] ? posted_backward : posted_forward;
            limits.push_back(values[graph.way[arc]]);
        }
        out.write(reinterpret_cast<const char*>(limits.data()), sizeof(uint16_t) * limits.size());
    }
    out.seekp(8);
    out.write(reinterpret_cast<const char*>(&core_size), sizeof(core_size));
    out.close();
    if (!out) throw std::runtime_error("Failed to write the routing graph.");
}
