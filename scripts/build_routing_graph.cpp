#include <routingkit/contraction_hierarchy.h>
#include <routingkit/osm_graph_builder.h>
#include <routingkit/osm_profile.h>
#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
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

int main(int argc, char** argv) {
    if (argc != 4) {
        std::cerr << "Usage: build-routing-graph INPUT.osm.pbf OUTPUT.bin MODE\n";
        return 1;
    }
    const std::string mode = argv[3];
    const bool drive = mode == "drive";
    const bool motorcycle = mode == "motorcycle";
    const bool tuk = mode == "tuk";
    const bool car = drive || motorcycle || tuk;
    const bool cycle = mode == "cycle";
    if (!car && !cycle && mode != "walk") return 1;
    auto log = [](const std::string& msg) { std::cerr << msg << '\n'; };
    auto mapping = load_osm_id_mapping_from_pbf(argv[1], nullptr,
        [&](uint64_t id, const TagMap& tags) {
            const std::string highway = tags["highway"] ? tags["highway"] : "";
            if (highway.empty()) return false;
            if (car) {
                if (!drive) {
                    const std::string motorroad = tags["motorroad"] ? tags["motorroad"] : "";
                    if (highway == "motorway" || highway == "motorway_link" || motorroad == "yes") return false;
                    const char* tag = motorcycle ? tags["motorcycle"] : nullptr;
                    if (tag && (std::string(tag) == "no" || std::string(tag) == "private")) return false;
                }
                const std::string vehicle = tags["motor_vehicle"] ? tags["motor_vehicle"] : "";
                const std::string motorcar = tags["motorcar"] ? tags["motorcar"] : "";
                if (vehicle == "private" || motorcar == "private" || motorcar == "no") return false;
                return is_osm_way_used_by_cars(id, tags);
            }
            const std::string motorroad = tags["motorroad"] ? tags["motorroad"] : "";
            if (motorroad == "yes" || highway == "motorway" || highway == "motorway_link") return false;
            if (cycle) return is_osm_way_used_by_bicycles(id, tags);
            const std::string foot = tags["foot"] ? tags["foot"] : "";
            const std::string access = tags["access"] ? tags["access"] : "";
            const std::string sidewalk = tags["sidewalk"] ? tags["sidewalk"] : "";
            if (foot == "no" || foot == "private" || foot == "use_sidepath") return false;
            if ((highway == "primary" || highway == "primary_link") &&
                sidewalk != "separate" && (access.empty() || access == "yes" || access == "permissive")) return true;
            return is_osm_way_used_by_pedestrians(id, tags);
        }, log, false);
    std::vector<unsigned> speed(mapping.is_routing_way.population_count());
    std::vector<uint16_t> posted_forward(drive ? speed.size() : 0), posted_backward(drive ? speed.size() : 0);
    auto graph = load_osm_routing_graph_from_pbf(argv[1], mapping,
        [&](uint64_t id, unsigned way, const TagMap& tags) {
            const unsigned top_speed = tuk ? 40 : motorcycle ? 80 : 130;
            speed[way] = car ? std::clamp(get_osm_way_speed(id, tags), 1u, top_speed) : cycle ? 16 : 5;
            if (car) {
                if (drive) {
                    posted_forward[way] = posted_limit(tags, "maxspeed:forward", "maxspeed:forward:conditional");
                    posted_backward[way] = posted_limit(tags, "maxspeed:backward", "maxspeed:backward:conditional");
                }
                return get_osm_car_direction_category(id, tags);
            }
            if (cycle) return get_osm_bicycle_direction_category(id, tags);
            return OSMWayDirectionCategory::open_in_both;
        },
        [&](uint64_t id, const std::vector<OSMRelationMember>& members, const TagMap& tags,
            std::function<void(OSMTurnRestriction)> emit) {
            if (car) decode_osm_car_turn_restrictions(id, members, tags, emit);
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
