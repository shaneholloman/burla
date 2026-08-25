import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { JobsStatus } from "@/types/coreTypes";
import { managementJson } from "@/lib/managementApi";
import { cn } from "@/lib/utils";

interface StructureNode {
    function_name: string;
    job_count: number;
    job_id: string | null;
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
    root: Omit<StructureNode, "children" | "status_counts"> & { status: string };
    groups: StructureNode[];
}

const STATUS_DOTS: { status: string; className: string; pulse?: boolean }[] = [
    { status: "running", className: "bg-sky-500", pulse: true },
    { status: "completed", className: "bg-emerald-500 dark:bg-emerald-400" },
    { status: "failed", className: "bg-destructive" },
    { status: "canceled", className: "bg-muted-foreground/60" },
];

const StatusDots = ({ counts }: { counts: Record<string, number> }) => (
    <span className="inline-flex items-center gap-2.5">
        {STATUS_DOTS.filter(({ status }) => counts[status]).map(({ status, className, pulse }) => (
            <span
                key={status}
                title={`${counts[status].toLocaleString()} ${status}`}
                className="inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
            >
                <span className={cn("h-1.5 w-1.5 rounded-full", className, pulse && "animate-pulse")} />
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

// ---------------------------------------------------------------- graph view

const NODE_W = 250;
const NODE_H = 98;
const GAP_X = 72;
const GAP_Y = 20;

interface LaidOutNode {
    node: StructureNode;
    depth: number;
    x: number;
    y: number;
    parent: LaidOutNode | null;
    isRoot: boolean;
}

// Tidy tree layout: leaves stack top-to-bottom, parents center on their
// children. Deterministic, so polling re-renders never shift the layout
// unless the structure itself changed.
const layOutTree = (root: StructureNode): LaidOutNode[] => {
    const nodes: LaidOutNode[] = [];
    let nextLeafSlot = 0;
    const place = (
        node: StructureNode,
        depth: number,
        parent: LaidOutNode | null,
        isRoot: boolean
    ): LaidOutNode => {
        const laidOut: LaidOutNode = { node, depth, x: depth * (NODE_W + GAP_X), y: 0, parent, isRoot };
        nodes.push(laidOut);
        if (node.children.length === 0) {
            laidOut.y = nextLeafSlot * (NODE_H + GAP_Y);
            nextLeafSlot += 1;
        } else {
            const childYs = node.children.map((child) => place(child, depth + 1, laidOut, false).y);
            laidOut.y = (Math.min(...childYs) + Math.max(...childYs)) / 2;
        }
        return laidOut;
    };
    place(root, 0, null, true);
    return nodes;
};

const GraphNodeCard = ({ laidOut }: { laidOut: LaidOutNode }) => {
    const { node, x, y, isRoot } = laidOut;
    const running = (node.status_counts["running"] ?? 0) > 0;
    const resources = perCallText(node);
    const body = (
        <>
            <div className="flex items-center gap-2">
                <span
                    title={node.function_name}
                    className="truncate font-mono text-[13px] font-medium text-foreground"
                >
                    {node.function_name}
                </span>
                {node.job_count > 1 && (
                    <span className="shrink-0 rounded-full border border-border bg-muted/60 px-1.5 py-[1px] text-[11px] font-medium tabular-nums text-muted-foreground">
                        ×{node.job_count.toLocaleString()}
                    </span>
                )}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[12px] tabular-nums text-foreground">
                    {node.result_count.toLocaleString()}
                    <span className="text-muted-foreground"> / {node.input_count.toLocaleString()} calls</span>
                </span>
                <StatusDots counts={node.status_counts} />
            </div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {resources}
                {node.running_parallelism > 0 && (
                    <span className="text-sky-600 dark:text-sky-400">
                        {resources ? " · " : ""}up to {node.running_parallelism.toLocaleString()} in flight
                    </span>
                )}
            </div>
        </>
    );
    const className = cn(
        "absolute rounded-lg border bg-card px-3.5 py-2.5 shadow-sm transition-colors",
        isRoot ? "border-primary/50" : "border-border",
        running && "ring-1 ring-sky-500/20",
        node.job_id && !isRoot && "cursor-pointer hover:border-primary/60"
    );
    const style = { left: x, top: y, width: NODE_W, height: NODE_H };
    if (node.job_id && !isRoot) {
        return (
            <Link to={`/jobs/${node.job_id}`} className={className} style={style}>
                {body}
            </Link>
        );
    }
    const title = node.job_count > 1 ? `${node.job_count} jobs, expand them in the Tree view` : undefined;
    return (
        <div className={className} style={style} title={title}>
            {body}
        </div>
    );
};

const StructureGraph = ({ root }: { root: StructureNode }) => {
    const laidOutNodes = useMemo(() => layOutTree(root), [root]);
    const width = (Math.max(...laidOutNodes.map((n) => n.depth)) + 1) * (NODE_W + GAP_X) - GAP_X;
    const height = Math.max(...laidOutNodes.map((n) => n.y)) + NODE_H;
    return (
        <div className="overflow-x-auto rounded-xl border border-border bg-card p-6 shadow-sm">
            <div
                className="relative"
                style={{
                    width,
                    height,
                    backgroundImage: "radial-gradient(hsl(var(--border)) 1px, transparent 1px)",
                    backgroundSize: "22px 22px",
                }}
            >
                <svg width={width} height={height} className="absolute inset-0">
                    {laidOutNodes
                        .filter((n) => n.parent)
                        .map((n) => {
                            const from = { x: n.parent!.x + NODE_W, y: n.parent!.y + NODE_H / 2 };
                            const to = { x: n.x, y: n.y + NODE_H / 2 };
                            const midX = (from.x + to.x) / 2;
                            return (
                                <path
                                    key={`${n.depth}-${n.node.function_name}-${n.y}`}
                                    d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
                                    fill="none"
                                    className="stroke-muted-foreground/40"
                                    strokeWidth={1.5}
                                />
                            );
                        })}
                </svg>
                {laidOutNodes.map((n) => (
                    <GraphNodeCard key={`${n.depth}-${n.node.function_name}-${n.y}`} laidOut={n} />
                ))}
            </div>
        </div>
    );
};

// ----------------------------------------------------------------- tree view

const TreeRow = ({ node, depth, isRoot }: { node: StructureNode; depth: number; isRoot?: boolean }) => {
    const [expanded, setExpanded] = useState(true);
    const hasChildren = node.children.length > 0;
    const resources = perCallText(node);
    return (
        <>
            <div
                className="flex items-center gap-2 border-b border-border/60 py-2 last:border-b-0"
                style={{ paddingLeft: depth * 26 }}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        onClick={() => setExpanded((previous) => !previous)}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={expanded ? "Collapse" : "Expand"}
                    >
                        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </button>
                ) : (
                    <span className="w-5 shrink-0" />
                )}
                {node.job_id && !isRoot ? (
                    <Link
                        to={`/jobs/${node.job_id}`}
                        className="truncate font-mono text-[13px] font-medium text-foreground hover:text-primary hover:underline"
                    >
                        {node.function_name}
                    </Link>
                ) : (
                    <span className="truncate font-mono text-[13px] font-medium text-foreground">
                        {node.function_name}
                    </span>
                )}
                {node.job_count > 1 && (
                    <span className="shrink-0 rounded-full border border-border bg-muted/60 px-1.5 py-[1px] text-[11px] font-medium tabular-nums text-muted-foreground">
                        ×{node.job_count.toLocaleString()}
                    </span>
                )}
                <span className="ml-2 shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {node.result_count.toLocaleString()} / {node.input_count.toLocaleString()}
                </span>
                <StatusDots counts={node.status_counts} />
                <span className="ml-auto shrink-0 pl-4 text-[11px] text-muted-foreground">
                    {resources}
                    {node.running_parallelism > 0 && (
                        <span className="text-sky-600 dark:text-sky-400">
                            {resources ? " · " : ""}up to {node.running_parallelism.toLocaleString()} in flight
                        </span>
                    )}
                </span>
            </div>
            {expanded &&
                node.children.map((child) => (
                    <TreeRow
                        key={`${child.function_name}-${child.job_id ?? "group"}`}
                        node={child}
                        depth={depth + 1}
                    />
                ))}
        </>
    );
};

const StructureTree = ({ root }: { root: StructureNode }) => (
    <div className="rounded-xl border border-border bg-card px-5 py-2 shadow-sm">
        <TreeRow node={root} depth={0} isRoot />
    </div>
);

// ------------------------------------------------------------------- wrapper

export const JobStructure = ({ jobId, jobStatus }: { jobId: string; jobStatus: JobsStatus | null }) => {
    const [tree, setTree] = useState<TreeResponse | null>(null);
    const [view, setView] = useState<"graph" | "tree">("graph");
    const isLive = jobStatus === "RUNNING" || jobStatus === "PENDING";

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

    const root: StructureNode | null = useMemo(() => {
        if (!tree) return null;
        return {
            ...tree.root,
            status_counts: { [tree.root.status]: 1 } as Record<string, number>,
            children: tree.groups,
        } as StructureNode;
    }, [tree]);

    if (!root) {
        return (
            <div className="flex justify-center py-12">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
            </div>
        );
    }

    return (
        <div>
            <div className="mb-3 flex items-center justify-between">
                <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
                    {(["graph", "tree"] as const).map((option) => (
                        <button
                            key={option}
                            type="button"
                            onClick={() => setView(option)}
                            className={cn(
                                "rounded-md px-3 py-1 text-[13px] font-medium capitalize transition-colors",
                                view === option
                                    ? "bg-card text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {option}
                        </button>
                    ))}
                </div>
                <span className="text-[12px] text-muted-foreground">
                    Nested jobs grouped by function{isLive ? ", updating live" : ""}
                </span>
            </div>
            {view === "graph" ? <StructureGraph root={root} /> : <StructureTree root={root} />}
        </div>
    );
};
