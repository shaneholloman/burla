import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import { managementJson } from "@/lib/managementApi";
import { StatusBadge, jobStatusBadge } from "@/components/StatusBadge";
import { TablePagination } from "@/components/TablePagination";
import { cn } from "@/lib/utils";

interface StructureNode {
    function_name: string;
    job_count: number;
    job_id: string | null;
    group_path: string;
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
    root: Omit<StructureNode, "children" | "status_counts" | "contains_current" | "group_path"> & {
        status: string;
    };
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

const formatDuration = (seconds: number | null): string => {
    if (seconds == null) return "—";
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const NODE_W = 250;
const NODE_H = 98;
const GAP_X = 72;
const GAP_Y = 20;

interface LaidOutNode {
    node: StructureNode;
    depth: number;
    row: number;
    x: number;
    y: number;
    parent: LaidOutNode | null;
}

// Column-sweep layout. A node's first child continues its row (the API puts
// the pipeline continuation first), so a chain of sequential stages renders
// as one straight line. Every other child is a branch, packed onto the first
// row below its parent that is still empty from its column onward, so
// branches sit tight under their junction with no blank rows. Deterministic,
// so polling re-renders never shift the layout unless the structure changed.
const layOutTree = (root: StructureNode): LaidOutNode[] => {
    const laid: LaidOutNode[] = [];
    const rightmostByRow: number[] = [];
    const branchesByCol: { node: StructureNode; parent: LaidOutNode }[][] = [];
    let maxCol = 0;

    const spineEnd = (node: StructureNode, col: number): number =>
        node.children.length === 0 ? col : spineEnd(node.children[0], col + 1);

    const placeSpine = (node: StructureNode, col: number, row: number, parent: LaidOutNode | null) => {
        const laidOut: LaidOutNode = {
            node,
            depth: col,
            row,
            x: col * (NODE_W + GAP_X),
            y: row * (NODE_H + GAP_Y),
            parent,
        };
        laid.push(laidOut);
        maxCol = Math.max(maxCol, col);
        rightmostByRow[row] = Math.max(rightmostByRow[row] ?? -1, col);
        node.children.forEach((child, index) => {
            if (index === 0) {
                placeSpine(child, col + 1, row, laidOut);
            } else {
                (branchesByCol[col + 1] ??= []).push({ node: child, parent: laidOut });
            }
        });
    };

    placeSpine(root, 0, 0, null);
    // Left-to-right so a branch never steals a row from anything to its left.
    for (let col = 1; col <= maxCol; col++) {
        for (const { node, parent } of branchesByCol[col] ?? []) {
            let row = parent.row + 1;
            while ((rightmostByRow[row] ?? -1) >= col) row += 1;
            // Reserve the branch's whole continuation line up front so later
            // branches can't be packed into the middle of it.
            rightmostByRow[row] = spineEnd(node, col);
            placeSpine(node, col, row, parent);
        }
    }
    return laid;
};

const GraphNodeCard = ({
    laidOut,
    currentJobId,
    onOpenGroup,
}: {
    laidOut: LaidOutNode;
    currentJobId: string;
    onOpenGroup: (node: StructureNode) => void;
}) => {
    const { node, x, y } = laidOut;
    // The job whose page is showing: highlighted, not a link.
    const isCurrent = node.job_id === currentJobId || !!node.contains_current;
    const isGroup = node.job_count > 1;
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
                {isGroup && (
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
    const clickable = isGroup || (node.job_id && !isCurrent);
    const className = cn(
        "absolute rounded-lg border bg-card px-3.5 py-2.5 text-left shadow-sm transition-colors",
        isCurrent ? "border-primary ring-1 ring-primary/30" : "border-border",
        running && !isCurrent && "ring-1 ring-sky-500/20",
        clickable && "cursor-pointer hover:border-primary/60"
    );
    const style = { left: x, top: y, width: NODE_W, height: NODE_H };
    if (isGroup) {
        return (
            <button
                type="button"
                onClick={() => onOpenGroup(node)}
                title={`View ${node.job_count.toLocaleString()} jobs`}
                className={className}
                style={style}
            >
                {body}
            </button>
        );
    }
    if (node.job_id && !isCurrent) {
        return (
            <Link to={`/jobs/${node.job_id}`} className={className} style={style}>
                {body}
            </Link>
        );
    }
    return (
        <div className={className} style={style}>
            {body}
        </div>
    );
};

const StructureGraph = ({
    root,
    currentJobId,
    onOpenGroup,
}: {
    root: StructureNode;
    currentJobId: string;
    onOpenGroup: (node: StructureNode) => void;
}) => {
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
                    <GraphNodeCard
                        key={`${n.depth}-${n.node.function_name}-${n.y}`}
                        laidOut={n}
                        currentJobId={currentJobId}
                        onOpenGroup={onOpenGroup}
                    />
                ))}
            </div>
        </div>
    );
};

const PAGE_SIZE = 15;
const CHIP_ORDER = ["running", "failed", "canceled", "completed"];

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
    const [data, setData] = useState<GroupMembersResponse | null>(null);

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
    }, [node.group_path, jobId, statusFilter, page, live]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    const statusCounts = data?.status_counts ?? node.status_counts;
    const allCount = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const totalPages = Math.max(1, Math.ceil((data?.total_count ?? 0) / PAGE_SIZE));

    const chip = (label: string, count: number, value: string | null) => (
        <button
            key={label}
            type="button"
            onClick={() => {
                setStatusFilter(value);
                setPage(0);
            }}
            className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] font-medium leading-none transition-colors",
                statusFilter === value
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
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
            <div className="fixed inset-y-0 right-0 z-50 flex w-[460px] max-w-[92vw] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-200">
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-sm font-semibold text-foreground">
                            {node.function_name}
                        </span>
                        <span className="shrink-0 rounded-full border border-border bg-muted/60 px-1.5 py-[1px] text-[11px] font-medium tabular-nums text-muted-foreground">
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
                    {CHIP_ORDER.filter((status) => statusCounts[status]).map((status) =>
                        chip(
                            status.charAt(0).toUpperCase() + status.slice(1),
                            statusCounts[status],
                            status
                        )
                    )}
                </div>

                <div className="mt-3 flex-1 overflow-y-auto px-5">
                    {data == null ? (
                        <div className="flex justify-center py-10">
                            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
                        </div>
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
                                    className="flex w-full items-center gap-3 border-b border-border/60 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/40"
                                >
                                    <StatusBadge tone={badge.tone} label={badge.label} pulse={badge.pulse} />
                                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                                        {idSuffix}
                                    </span>
                                    <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                                        {member.result_count.toLocaleString()} /{" "}
                                        {member.input_count.toLocaleString()}
                                    </span>
                                    <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                                        {formatDuration(member.duration_seconds)}
                                    </span>
                                    <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                                        {startedText(member.started_at)}
                                    </span>
                                </button>
                            );
                        })
                    )}
                </div>

                <div className="border-t border-border px-5 pb-4">
                    <TablePagination
                        page={page}
                        totalPages={totalPages}
                        onPageChange={setPage}
                        resultsLabel={`${(data?.total_count ?? 0).toLocaleString()} jobs`}
                    />
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
            <StructureGraph root={root} currentJobId={jobId} onOpenGroup={openGroup} />
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
