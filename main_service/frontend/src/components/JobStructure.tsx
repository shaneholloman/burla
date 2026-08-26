import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronRight, ListTree, X } from "lucide-react";
import { managementJson } from "@/lib/managementApi";
import { StatusBadge, jobStatusBadge } from "@/components/StatusBadge";
import { TablePagination } from "@/components/TablePagination";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface StructureNode {
    function_name: string;
    job_count: number;
    job_id: string | null;
    group_path: string;
    chained: boolean;
    contains_current?: boolean;
    status_counts: Record<string, number>;
    input_count: number;
    result_count: number;
    cpu_per_call: number | string | null;
    ram_per_call: number | string | null;
    gpu_per_call: string | null;
    running_parallelism: number;
    children: StructureNode[];
}

interface TreeResponse {
    root: Omit<
        StructureNode,
        "children" | "status_counts" | "contains_current" | "group_path" | "chained"
    > & { status: string };
    groups: StructureNode[];
}

interface GroupMember {
    job_id: string;
    status: string;
    input_count: number;
    result_count: number;
    started_at: string | null;
    duration_seconds: number | null;
}

interface GroupMembersResponse {
    items: GroupMember[];
    total_count: number;
    status_counts: Record<string, number>;
}

// Running and completed share one healthy green; motion is what says "still
// going": running dots breathe, finished dots hold still.
const STATUS_DOTS: { status: string; className: string; breathe?: boolean }[] = [
    { status: "running", className: "bg-emerald-500 dark:bg-emerald-400", breathe: true },
    { status: "completed", className: "bg-emerald-500 dark:bg-emerald-400" },
    { status: "failed", className: "bg-destructive" },
    { status: "canceled", className: "bg-muted-foreground/60" },
];

const StatusDots = ({ counts }: { counts: Record<string, number> }) => (
    <span className="inline-flex items-center gap-2.5">
        {STATUS_DOTS.filter(({ status }) => counts[status]).map(({ status, className, breathe }) => (
            <span
                key={status}
                title={`${counts[status].toLocaleString()} ${status}`}
                className="inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
            >
                <span className={cn("h-1.5 w-1.5 rounded-full", className, breathe && "graph-breathe")} />
                {counts[status].toLocaleString()}
            </span>
        ))}
    </span>
);

const perCallText = (node: StructureNode): string => {
    const part = (value: number | string | null, unit: string) => {
        if (value == null) return null;
        if (value === "dynamic") return `Dyn ${unit}`;
        if (value === "mixed") return `Mixed ${unit}`;
        return `${value} ${unit}`;
    };
    const parts = [part(node.cpu_per_call, "vCPU"), part(node.ram_per_call, "GB")];
    if (node.gpu_per_call) parts.push(String(node.gpu_per_call));
    return parts.filter(Boolean).join(" · ");
};

const formatDuration = (seconds: number | null): string => {
    if (seconds == null) return "—";
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const NODE_W = 220;
const NODE_H = 70;
const GAP_X = 48;
const GAP_Y = 18;
// Containment region geometry: the parent card overlaps the region's top edge
// like a tab on a folder, and the interior sits inset within the region.
const REGION_INDENT = 16;
const REGION_PAD_X = 12;
const REGION_HEAD = 20;
const REGION_PAD_BOTTOM = 12;
const TAB_OVERLAP = 10;
const ROW_GAP = 14;

interface PlacedNode {
    node: StructureNode;
    x: number;
    y: number;
    opacity?: number;
}

interface RegionRect {
    key: string;
    x: number;
    y: number;
    width: number;
    height: number;
    depth: number;
    opacity?: number;
}

interface GraphEdge {
    from: PlacedNode;
    to: PlacedNode;
}

interface GraphLayout {
    nodes: PlacedNode[];
    regions: RegionRect[];
    edges: GraphEdge[];
    width: number;
    height: number;
}

// Every job in a node's interior, transitively: its nested children plus
// everything below them (their chains run inside the same enclosure).
const subtreeJobs = (node: StructureNode): number =>
    node.job_count + node.children.reduce((total, child) => total + subtreeJobs(child), 0);

const nestedJobsInside = (node: StructureNode): number =>
    node.children
        .filter((child) => !child.chained)
        .reduce((total, child) => total + subtreeJobs(child), 0);

// Recursive block layout that draws containment as space, not edges: a node
// with nested jobs grows a tinted region hanging off its underside and its
// nested constellation renders inside it (recursively), while chained
// next-stage nodes continue to the right of the node's whole block, connected
// by flow arrows. Collapsed nodes lay out as a bare card: their interior is
// simply absent. Deterministic, so polling re-renders never shift the layout
// unless the structure (or expansion state) changed.
const layOutWorkload = (root: StructureNode, isExpanded: (node: StructureNode) => boolean): GraphLayout => {
    const nodes: PlacedNode[] = [];
    const regions: RegionRect[] = [];
    const edges: GraphEdge[] = [];

    const placeBlock = (
        node: StructureNode,
        x: number,
        y: number,
        regionDepth: number
    ): { w: number; h: number; self: PlacedNode } => {
        const self: PlacedNode = { node, x, y };
        nodes.push(self);
        let width = NODE_W;
        let height = NODE_H;

        const nested = isExpanded(node) ? node.children.filter((child) => !child.chained) : [];
        const chained = node.children.filter((child) => child.chained);

        if (nested.length > 0) {
            const regionX = x + REGION_INDENT;
            const innerX = regionX + REGION_PAD_X;
            let cursorY = y + NODE_H + REGION_HEAD;
            let innerRight = innerX + NODE_W;
            for (const child of nested) {
                const block = placeBlock(child, innerX, cursorY, regionDepth + 1);
                innerRight = Math.max(innerRight, innerX + block.w);
                cursorY += block.h + ROW_GAP;
            }
            const regionY = y + NODE_H - TAB_OVERLAP;
            const region: RegionRect = {
                key: node.group_path ?? "root",
                x: regionX,
                y: regionY,
                width: innerRight + REGION_PAD_X - regionX,
                height: cursorY - ROW_GAP + REGION_PAD_BOTTOM - regionY,
                depth: regionDepth,
            };
            regions.push(region);
            width = Math.max(width, region.x + region.width - x);
            height = Math.max(height, region.y + region.height - y);
        }

        if (chained.length > 0) {
            const chainX = x + width + GAP_X;
            let cursorY = y;
            let chainWidth = 0;
            for (const child of chained) {
                const block = placeBlock(child, chainX, cursorY, regionDepth);
                edges.push({ from: self, to: block.self });
                chainWidth = Math.max(chainWidth, block.w);
                height = Math.max(height, cursorY + block.h - y);
                cursorY += block.h + GAP_Y;
            }
            width += GAP_X + chainWidth;
        }

        return { w: width, h: height, self };
    };

    const total = placeBlock(root, 0, 0, 0);
    return { nodes, regions, edges, width: total.w, height: total.h };
};

const GraphNodeCard = ({
    placed,
    currentJobId,
    onOpenGroup,
    isExpanded,
}: {
    placed: PlacedNode;
    currentJobId: string;
    onOpenGroup: (node: StructureNode) => void;
    isExpanded: boolean;
}) => {
    const { node, x, y } = placed;
    const isRoot = node.group_path == null;
    const insideCount = nestedJobsInside(node);
    // The job whose page is showing: highlighted, not a link.
    const isCurrent = node.job_id === currentJobId || !!node.contains_current;
    const isGroup = node.job_count > 1;
    const resources = perCallText(node);
    const body = (
        <>
            <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[13px] font-medium text-foreground">
                    {node.function_name}
                </span>
                {isGroup && (
                    <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                        ×{node.job_count.toLocaleString()}
                    </span>
                )}
                {/* Nested-jobs indicator: this job contains N jobs; its region
                    opens while the job is being viewed. */}
                {!isRoot && insideCount > 0 && (
                    <span
                        title={`Contains ${insideCount.toLocaleString()} nested job${insideCount === 1 ? "" : "s"}`}
                        className={cn(
                            "ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-[3px] text-[11px] font-semibold tabular-nums",
                            isExpanded
                                ? "bg-primary/15 text-primary"
                                : "bg-[hsl(var(--graph-well-1))] text-muted-foreground"
                        )}
                    >
                        <ListTree className="h-3.5 w-3.5" />
                        {insideCount.toLocaleString()}
                    </span>
                )}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[12px] tabular-nums text-foreground">
                    {node.result_count.toLocaleString()}
                    <span className="text-muted-foreground"> / {node.input_count.toLocaleString()} calls</span>
                    {node.running_parallelism > 0 && (
                        <span className="text-primary">
                            {" "}
                            · {node.running_parallelism.toLocaleString()} in flight
                        </span>
                    )}
                </span>
                <StatusDots counts={node.status_counts} />
            </div>
        </>
    );
    const clickable = isGroup || (node.job_id && !isCurrent);
    const innerClassName = cn(
        "relative flex h-full w-full flex-col justify-center rounded-lg bg-[hsl(var(--graph-node))] px-3.5 text-left shadow-md transition-shadow",
        // The current job wears the only outline on the canvas.
        isCurrent && "ring-2 ring-primary",
        clickable && "cursor-pointer hover:ring-1 hover:ring-primary/50"
    );
    const title = [
        isGroup ? `View ${node.job_count.toLocaleString()} jobs` : node.function_name,
        resources,
    ]
        .filter(Boolean)
        .join("\n");
    const inner = isGroup ? (
        <button type="button" onClick={() => onOpenGroup(node)} className={innerClassName}>
            {body}
        </button>
    ) : node.job_id && !isCurrent ? (
        <Link to={`/jobs/${node.job_id}`} className={innerClassName}>
            {body}
        </Link>
    ) : (
        <div className={innerClassName}>{body}</div>
    );
    return (
        <div
            className="absolute"
            style={{ left: x, top: y, width: NODE_W, height: NODE_H, opacity: placed.opacity ?? 1 }}
            title={title}
        >
            {/* Stacked-card effect: a same-size card offset down-right, so a
                group of jobs reads as a pile, not one job. */}
            {isGroup && (
                <span
                    aria-hidden
                    className="absolute inset-0 translate-x-[8px] translate-y-[8px] rounded-lg bg-[hsl(var(--graph-node))] brightness-90 shadow-sm"
                />
            )}
            {inner}
        </div>
    );
};

// Room for the 6px arrowhead between the line's end and the node's edge: the
// line ends at the back of the head, like a shaft meeting an arrowhead.
const EDGE_INSET = 7;
const EDGE_FADE_WIDTH = 40;
const LAYOUT_ANIMATION_MS = 200;
const REVEAL_FADE_MS = 120;
const CANVAS_PAD = 24;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const nodeKey = (placed: PlacedNode) => placed.node.group_path ?? "root";

const layoutSignature = (layout: GraphLayout) =>
    [
        layout.nodes.map((p) => `${nodeKey(p)}:${Math.round(p.x)},${Math.round(p.y)}`).join("|"),
        layout.regions
            .map(
                (r) =>
                    `${r.key}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`
            )
            .join("|"),
    ].join("#");

// One tween drives cards, regions, edges, and the canvas together, so arrows
// stay pinned to the cards they connect throughout the animation (CSS can
// transition positions but not SVG path geometry). Two sub-timelines: existing
// geometry glides during geoT, and only once the space has fully opened does
// newly revealed content fade in (fadeT), so nothing ever renders outside its
// region or under a card that hasn't moved yet.
const interpolateLayout = (
    from: GraphLayout,
    to: GraphLayout,
    geoT: number,
    fadeT: number
): GraphLayout => {
    if (geoT >= 1 && fadeT >= 1) return to;
    // Whole pixels only: fractional card positions against the browser's
    // integer scroll quantization make a pinned card vibrate by ~1px.
    const lerp = (a: number, b: number) => Math.round(a + (b - a) * geoT);
    // An item caught mid-fade when the tween retargets (fresh tree data) must
    // keep fading from where it was, never pop to full opacity.
    const carryOpacity = (previous: { opacity?: number }) =>
        previous.opacity != null && previous.opacity < 1
            ? Math.max(previous.opacity, fadeT)
            : undefined;
    const fromNodes = new Map(from.nodes.map((p) => [nodeKey(p), p]));
    const nodes = to.nodes.map((placed) => {
        const previous = fromNodes.get(nodeKey(placed));
        return previous
            ? {
                  ...placed,
                  x: lerp(previous.x, placed.x),
                  y: lerp(previous.y, placed.y),
                  opacity: carryOpacity(previous),
              }
            : { ...placed, opacity: fadeT };
    });
    const byKey = new Map(nodes.map((placed) => [nodeKey(placed), placed]));
    const edges = to.edges.map((edge) => ({
        from: byKey.get(nodeKey(edge.from)) ?? edge.from,
        to: byKey.get(nodeKey(edge.to)) ?? edge.to,
    }));
    const fromRegions = new Map(from.regions.map((region) => [region.key, region]));
    const regions = to.regions.map((region) => {
        const previous = fromRegions.get(region.key);
        return previous
            ? {
                  ...region,
                  x: lerp(previous.x, region.x),
                  y: lerp(previous.y, region.y),
                  width: lerp(previous.width, region.width),
                  height: lerp(previous.height, region.height),
                  opacity: carryOpacity(previous),
              }
            : { ...region, opacity: fadeT };
    });
    return {
        nodes,
        regions,
        edges,
        width: lerp(from.width, to.width),
        height: lerp(from.height, to.height),
    };
};

const StructureGraph = ({
    root,
    currentJobId,
    onOpenGroup,
    expanded,
}: {
    root: StructureNode;
    currentJobId: string;
    onOpenGroup: (node: StructureNode) => void;
    expanded: Set<string>;
}) => {
    const navigate = useNavigate();
    const target = useMemo(
        () =>
            layOutWorkload(
                root,
                (node) => node.group_path == null || expanded.has(node.group_path)
            ),
        [root, expanded]
    );

    const scrollRef = useRef<HTMLDivElement>(null);
    const hasCenteredRef = useRef(false);
    const [fades, setFades] = useState({ left: false, right: false });
    const updateFades = () => {
        const el = scrollRef.current;
        if (!el) return;
        setFades({
            left: el.scrollLeft > 1,
            right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
        });
    };

    // What actually renders: the target layout, or a frame on the way there.
    const [layout, setLayout] = useState<GraphLayout>(target);
    const layoutRef = useRef(target);
    useEffect(() => {
        layoutRef.current = layout;
    }, [layout]);
    const frameRef = useRef<number>();
    const pendingScrollRef = useRef<number | null>(null);
    useLayoutEffect(() => {
        if (pendingScrollRef.current != null && scrollRef.current) {
            scrollRef.current.scrollLeft = pendingScrollRef.current;
            pendingScrollRef.current = null;
        }
    }, [layout]);
    useEffect(() => {
        const from = layoutRef.current;
        if (layoutSignature(from) === layoutSignature(target)) {
            // Same geometry (e.g. a data-only poll refresh): adopt without
            // animating.
            setLayout(target);
            return;
        }
        const el = scrollRef.current;

        // The selected card must not move on screen: the world reflows around
        // it. Each frame we counter-scroll by exactly how far the anchor's
        // layout position has moved, keeping it pixel-stationary. Exact id
        // first: contains_current is stale for a moment after navigating.
        const findCurrent = (candidates: PlacedNode[]) =>
            candidates.find((n) => n.node.job_id === currentJobId) ??
            candidates.find((n) => n.node.contains_current);
        const anchorTo = findCurrent(target.nodes);
        const anchorFrom = anchorTo
            ? layoutRef.current.nodes.find((p) => nodeKey(p) === nodeKey(anchorTo))
            : undefined;
        // Pin any anchor that is at least partially visible; if it sits in an
        // edge zone, ease it into the safe band as part of the same tween
        // (one continuous motion, never a correction pass afterwards). Fully
        // off-screen anchors scroll into view once the motion settles.
        let anchorPin: { fromViewportX: number; toViewportX: number } | null = null;
        if (el && anchorTo && anchorFrom) {
            const viewportX = anchorFrom.x + CANVAS_PAD - el.scrollLeft;
            if (viewportX > -NODE_W && viewportX < el.clientWidth) {
                const safeMin = EDGE_FADE_WIDTH;
                const safeMax = Math.max(safeMin, el.clientWidth - NODE_W - EDGE_FADE_WIDTH);
                anchorPin = {
                    fromViewportX: viewportX,
                    toViewportX: Math.min(Math.max(viewportX, safeMin), safeMax),
                };
            }
        }

        const startedAt = performance.now();
        const step = (now: number) => {
            const elapsed = now - startedAt;
            const geoT = easeInOut(Math.min(1, elapsed / LAYOUT_ANIMATION_MS));
            const fadeT =
                elapsed <= LAYOUT_ANIMATION_MS
                    ? 0
                    : Math.min(1, (elapsed - LAYOUT_ANIMATION_MS) / REVEAL_FADE_MS);
            // Queue the counter-scroll so the layout effect applies it in the
            // SAME commit as the interpolated positions: setting scrollLeft
            // here directly would lead the (async) React render by a frame
            // and make the pinned card shimmy.
            if (el && anchorPin && anchorTo && anchorFrom) {
                // Rounded with the exact same expression the renderer uses for
                // the card's x, so anchor position minus scroll is a constant
                // integer: any mismatch reads as a 1px vibration.
                const anchorX = Math.round(
                    anchorFrom.x + (anchorTo.x - anchorFrom.x) * geoT
                );
                const viewportX = Math.round(
                    anchorPin.fromViewportX +
                        (anchorPin.toViewportX - anchorPin.fromViewportX) * geoT
                );
                pendingScrollRef.current = Math.max(0, anchorX + CANVAS_PAD - viewportX);
            }
            setLayout(interpolateLayout(from, target, geoT, fadeT));
            if (elapsed < LAYOUT_ANIMATION_MS + REVEAL_FADE_MS) {
                frameRef.current = requestAnimationFrame(step);
                return;
            }
            if (el && anchorTo && anchorPin == null) {
                const nodeLeft = anchorTo.x + CANVAS_PAD;
                const nodeRight = nodeLeft + NODE_W;
                const safeLeft = el.scrollLeft + EDGE_FADE_WIDTH;
                const safeRight = el.scrollLeft + el.clientWidth - EDGE_FADE_WIDTH;
                if (nodeLeft < safeLeft) {
                    el.scrollTo({ left: Math.max(0, nodeLeft - EDGE_FADE_WIDTH), behavior: "smooth" });
                } else if (nodeRight > safeRight) {
                    el.scrollTo({
                        left: nodeRight + EDGE_FADE_WIDTH - el.clientWidth,
                        behavior: "smooth",
                    });
                }
            }
        };
        frameRef.current = requestAnimationFrame(step);
        return () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    // Center "you are here" on first render only: later navigation within the
    // workload keeps whatever scroll position the user has.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && !hasCenteredRef.current) {
            const current =
                target.nodes.find((n) => n.node.job_id === currentJobId) ??
                target.nodes.find((n) => n.node.contains_current);
            // The current node may not be laid out yet on the very first
            // render (its ancestors auto-expand one render later), so keep
            // waiting until it exists.
            if (current) {
                hasCenteredRef.current = true;
                el.scrollLeft = Math.max(0, current.x - (el.clientWidth - NODE_W) / 2);
            }
        }
        updateFades();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target, layout, currentJobId]);

    return (
        <div className="relative rounded-xl border border-border bg-card shadow-sm">
            <div
                ref={scrollRef}
                onScroll={updateFades}
                className="graph-scroll overflow-x-auto rounded-xl"
            >
                {/* Recessed canvas: darker than the node cards in both themes
                    so the cards float, with the dot grid kept faint. Clicking
                    the empty canvas deselects: back to the root job, which
                    collapses every open region. */}
                <div
                    className="min-w-full w-max bg-background p-6"
                    onClick={(event) => {
                        if ((event.target as HTMLElement).closest("a,button")) return;
                        if (root.job_id && currentJobId !== root.job_id) {
                            navigate(`/jobs/${root.job_id}`);
                        }
                    }}
                    style={{
                        backgroundImage:
                            "radial-gradient(hsl(var(--border) / 0.6) 1px, transparent 1px)",
                        backgroundSize: "22px 22px",
                    }}
                >
                    <div className="relative" style={{ width: layout.width, height: layout.height }}>
                    {/* Containment regions: everything inside a region runs
                        inside the job card sitting on its top edge. Painted
                        first so edges and cards render above; deeper regions
                        paint later, so nesting reads as a slightly deeper
                        tint. */}
                    {/* Shallow regions first: fills are opaque, so an outer
                        region painted later would hide the wells nested
                        inside it. */}
                    {[...layout.regions].sort((a, b) => a.depth - b.depth).map((region) => (
                        <div
                            key={region.key}
                            className={cn(
                                "pointer-events-none absolute rounded-xl",
                                region.depth % 2 === 0
                                    ? "bg-[hsl(var(--graph-well-1))]"
                                    : "bg-[hsl(var(--graph-well-2))]"
                            )}
                            style={{
                                left: region.x,
                                top: region.y,
                                width: region.width,
                                height: region.height,
                                opacity: region.opacity ?? 1,
                            }}
                        />
                    ))}
                    <svg
                        width={layout.width}
                        height={layout.height}
                        className="absolute inset-0 overflow-visible"
                    >
                        <defs>
                            {/* refX=0 anchors the BACK of the head at the line's
                                end, so the shaft meets the arrowhead. */}
                            <marker
                                id="arrow-flow"
                                markerWidth="6"
                                markerHeight="6"
                                refX="0"
                                refY="3"
                                orient="auto"
                                markerUnits="userSpaceOnUse"
                            >
                                <path
                                    d="M0,0 L6,3 L0,6 Z"
                                    style={{ fill: "hsl(var(--muted-foreground))", fillOpacity: 0.7 }}
                                />
                            </marker>
                        </defs>
                        {layout.edges.map(({ from, to }) => {
                            const start = { x: from.x + NODE_W, y: from.y + NODE_H / 2 };
                            const end = { x: to.x - EDGE_INSET, y: to.y + NODE_H / 2 };
                            const midX = (start.x + end.x) / 2;
                            const path =
                                start.y === end.y
                                    ? `M ${start.x} ${start.y} L ${end.x} ${end.y}`
                                    : `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`;
                            return (
                                <path
                                    key={to.node.group_path}
                                    d={path}
                                    fill="none"
                                    className="stroke-muted-foreground/70"
                                    strokeWidth={1.5}
                                    markerEnd="url(#arrow-flow)"
                                    opacity={Math.min(from.opacity ?? 1, to.opacity ?? 1)}
                                />
                            );
                        })}
                    </svg>
                    {layout.nodes.map((placed) => (
                        <GraphNodeCard
                            key={placed.node.group_path ?? "root"}
                            placed={placed}
                            currentJobId={currentJobId}
                            onOpenGroup={onOpenGroup}
                            isExpanded={
                                placed.node.group_path == null ||
                                expanded.has(placed.node.group_path)
                            }
                        />
                    ))}
                    </div>
                </div>
            </div>

            {fades.left && (
                <div className="pointer-events-none absolute inset-y-0 left-0 w-10 rounded-l-xl bg-gradient-to-r from-background to-transparent" />
            )}
            {fades.right && (
                <div className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-xl bg-gradient-to-l from-background to-transparent" />
            )}
        </div>
    );
};

const PAGE_SIZE = 15;
const CHIP_ORDER = ["running", "failed", "completed"];

// Right-hand drawer listing the member jobs of one grouped graph node.
// Anchored in the URL (?group=...) so back / refresh / share all work.
const GroupDrawer = ({
    node,
    jobId,
    live,
    onClose,
}: {
    node: StructureNode;
    jobId: string;
    live: boolean;
    onClose: () => void;
}) => {
    const navigate = useNavigate();
    const [statusFilter, setStatusFilter] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [searchTerm, setSearchTerm] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [data, setData] = useState<GroupMembersResponse | null>(null);

    useEffect(() => {
        const id = window.setTimeout(() => setDebouncedSearch(searchTerm.trim()), 250);
        return () => window.clearTimeout(id);
    }, [searchTerm]);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const query = new URLSearchParams({
                    path: node.group_path,
                    offset: String(page * PAGE_SIZE),
                    limit: String(PAGE_SIZE),
                });
                if (statusFilter) query.set("status", statusFilter);
                if (debouncedSearch) query.set("search", debouncedSearch);
                const response = await managementJson<GroupMembersResponse>(
                    `/jobs/${jobId}/tree/members?${query}`
                );
                if (!cancelled) setData(response);
            } catch (err) {
                console.error("Error fetching group members:", err);
            }
        };
        load();
        if (!live) return;
        const id = window.setInterval(load, 3000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [node.group_path, jobId, statusFilter, debouncedSearch, page, live]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    const statusCounts = data?.status_counts ?? node.status_counts;
    const allCount = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const totalCount = data?.total_count ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    const chip = (label: string, count: number, value: string | null) => (
        <button
            key={label}
            type="button"
            disabled={count === 0}
            onClick={() => {
                setStatusFilter(value);
                setPage(0);
            }}
            className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] font-medium leading-none transition-colors",
                statusFilter === value
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                count === 0 && "opacity-45"
            )}
        >
            {label} <span className="tabular-nums">{count.toLocaleString()}</span>
        </button>
    );

    const startedText = (iso: string | null) => {
        if (!iso) return "—";
        return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    };

    return (
        <>
            <div
                className="fixed inset-0 z-40 bg-black/25 animate-in fade-in-0 duration-150"
                onClick={onClose}
            />
            <div className="fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-[92vw] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-200">
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-sm font-semibold text-foreground">
                            {node.function_name}
                        </span>
                        <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                            ×{node.job_count.toLocaleString()}
                        </span>
                    </div>
                    <button
                        type="button"
                        aria-label="Close"
                        onClick={onClose}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex flex-wrap gap-1.5 px-5 pt-4">
                    {chip("All", allCount, null)}
                    {CHIP_ORDER.map((status) =>
                        chip(
                            status.charAt(0).toUpperCase() + status.slice(1),
                            statusCounts[status] ?? 0,
                            status
                        )
                    )}
                </div>

                {allCount > PAGE_SIZE && (
                    <div className="px-5 pt-3">
                        <Input
                            value={searchTerm}
                            onChange={(event) => {
                                setSearchTerm(event.target.value);
                                setPage(0);
                            }}
                            placeholder="Search by job id…"
                            className="h-8 text-[13px]"
                        />
                    </div>
                )}

                <div className="mt-3 flex items-center gap-3 border-b border-border px-5 pb-2 text-[11px] font-medium text-muted-foreground">
                    <span className="w-[92px] shrink-0">Status</span>
                    <span className="min-w-0 flex-1">Job</span>
                    <span className="w-14 shrink-0 text-right">Calls</span>
                    <span className="w-12 shrink-0 text-right">Duration</span>
                    <span className="w-16 shrink-0 text-right">Started</span>
                    <span className="w-3.5 shrink-0" />
                </div>

                <div className="flex-1 overflow-y-auto px-5">
                    {data == null ? (
                        <div className="flex justify-center py-10">
                            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
                        </div>
                    ) : data.items.length === 0 ? (
                        <p className="py-8 text-center text-[13px] text-muted-foreground">
                            No matching jobs.
                        </p>
                    ) : (
                        data.items.map((member) => {
                            const badge = jobStatusBadge(member.status.toUpperCase());
                            const idSuffix =
                                member.job_id.slice(node.function_name.length + 1) || member.job_id;
                            return (
                                <button
                                    key={member.job_id}
                                    type="button"
                                    onClick={() => navigate(`/jobs/${member.job_id}`)}
                                    title={member.job_id}
                                    className="group flex w-full items-center gap-3 border-b border-border/60 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/40"
                                >
                                    <span className="flex w-[92px] shrink-0">
                                        <StatusBadge
                                            tone={badge.tone}
                                            label={badge.label}
                                            pulse={badge.pulse}
                                        />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                                        {idSuffix}
                                    </span>
                                    <span className="w-14 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                                        {member.result_count.toLocaleString()} /{" "}
                                        {member.input_count.toLocaleString()}
                                    </span>
                                    <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                                        {formatDuration(member.duration_seconds)}
                                    </span>
                                    <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                                        {startedText(member.started_at)}
                                    </span>
                                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                                </button>
                            );
                        })
                    )}
                </div>

                <div className="border-t border-border px-5 pb-4">
                    {totalPages > 1 ? (
                        <TablePagination
                            page={page}
                            totalPages={totalPages}
                            onPageChange={setPage}
                            resultsLabel={`${totalCount.toLocaleString()} jobs`}
                        />
                    ) : (
                        <p className="pt-4 text-[13px] text-muted-foreground">
                            {totalCount.toLocaleString()} job{totalCount === 1 ? "" : "s"}
                        </p>
                    )}
                </div>
            </div>
        </>
    );
};

const hasLiveJobs = (node: StructureNode): boolean =>
    ["running", "pending"].some((status) => node.status_counts[status]) ||
    node.children.some(hasLiveJobs);

const findGroup = (nodes: StructureNode[], path: string): StructureNode | null => {
    for (const node of nodes) {
        if (node.group_path === path) return node;
        const found = findGroup(node.children, path);
        if (found) return found;
    }
    return null;
};

// The target node plus the region owners standing between the root and it:
// each owner must be expanded for the target to be visible. Descending a
// chained edge stays in the same region, so it adds no owner.
const pathToTarget = (
    node: StructureNode,
    isTarget: (candidate: StructureNode) => boolean,
    owners: string[]
): { owners: string[]; node: StructureNode } | null => {
    if (isTarget(node)) return { owners, node };
    for (const child of node.children) {
        const nextOwners = child.chained ? owners : [...owners, node.group_path ?? "root"];
        const found = pathToTarget(child, isTarget, nextOwners);
        if (found) return found;
    }
    return null;
};

// The graph of the whole nested workload this job belongs to (always the full
// graph from the outermost root, whichever member job's page is showing, so
// clicking around the workload keeps the graph in place). Renders nothing for
// jobs with no nested structure.
export const JobStructure = ({ jobId }: { jobId: string }) => {
    const [tree, setTree] = useState<TreeResponse | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();

    const root: StructureNode | null = useMemo(() => {
        if (!tree) return null;
        return {
            ...tree.root,
            status_counts: { [tree.root.status]: 1 } as Record<string, number>,
            children: tree.groups,
        } as StructureNode;
    }, [tree]);

    const isLive = root == null || hasLiveJobs(root);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const data = await managementJson<TreeResponse>(`/jobs/${jobId}/tree`);
                if (!cancelled) setTree(data);
            } catch (err) {
                console.error("Error fetching job tree:", err);
            }
        };
        load();
        if (!isLive) return;
        const id = window.setInterval(load, 3000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [jobId, isLive]);

    const groupPath = searchParams.get("group");
    const groupNode = useMemo(
        () => (root && groupPath ? findGroup(root.children, groupPath) : null),
        [root, groupPath]
    );

    // Expansion is selection-driven, never a separate control: the regions
    // open are exactly those of the job being viewed (and an open drawer's
    // group) plus their enclosing regions. Clicking a job expands it because
    // clicking navigates to it; clicking anything else collapses it because
    // it is no longer the selection.
    const expanded = useMemo(() => {
        const paths = new Set<string>();
        if (!root) return paths;
        // Exact id first: contains_current comes from the tree fetch and is
        // stale for a moment after navigating, which would briefly keep the
        // previous job's region expanded.
        const found = [
            pathToTarget(root, (node) => node.job_id === jobId, []) ??
                pathToTarget(root, (node) => !!node.contains_current, []),
            groupPath ? pathToTarget(root, (node) => node.group_path === groupPath, []) : null,
        ];
        for (const target of found) {
            if (!target) continue;
            target.owners.forEach((owner) => paths.add(owner));
            if (target.node.group_path != null) paths.add(target.node.group_path);
        }
        paths.delete("root");
        return paths;
    }, [root, jobId, groupPath]);

    const openGroup = (node: StructureNode) => {
        const sp = new URLSearchParams(searchParams);
        sp.set("group", node.group_path);
        setSearchParams(sp);
    };

    const closeGroup = () => {
        const sp = new URLSearchParams(searchParams);
        sp.delete("group");
        setSearchParams(sp);
    };

    if (!root || root.children.length === 0) return null;

    return (
        <div className="mb-4">
            <StructureGraph
                root={root}
                currentJobId={jobId}
                onOpenGroup={openGroup}
                expanded={expanded}
            />
            {groupNode && (
                <GroupDrawer
                    key={groupNode.group_path}
                    node={groupNode}
                    jobId={jobId}
                    live={isLive}
                    onClose={closeGroup}
                />
            )}
        </div>
    );
};
