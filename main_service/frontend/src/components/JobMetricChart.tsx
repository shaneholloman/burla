import {
    Area,
    AreaChart,
    CartesianGrid,
    ReferenceArea,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

export const PRIMARY = "hsl(var(--primary))";
export const SECONDARY = "hsl(215 14% 55%)";
// Matches the amber "warning" badge tone; used to shade throttled spans.
const THROTTLE = "hsl(38 92% 50%)";

// A span of chart time during which the worker was parked (CPU-throttled) by
// the node's pressure controls. `intensity` is the fraction of the span's
// sampled time actually spent throttled (0..1), used to scale the shading.
export type ThrottleBand = {
    from: number;
    to: number;
    intensity: number;
};

const ThrottleSwatch = () => (
    <span
        className="h-2 w-2 rounded-[3px]"
        style={{
            background:
                "repeating-linear-gradient(45deg, transparent 0 2px, " +
                "hsl(38 92% 50% / 0.6) 2px 3px), hsl(38 92% 50% / 0.12)",
            boxShadow: "inset 0 0 0 1px hsl(38 92% 50% / 0.45)",
        }}
    />
);

// Non-breaking space so axis tick labels stay on one line.
export const formatBytes = (value: number): string => {
    if (value < 1024) return `${Math.round(value)}\u00A0B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = value / 1024;
    let unit = 0;
    while (v >= 1024 && unit < units.length - 1) {
        v /= 1024;
        unit += 1;
    }
    return `${v >= 10 ? Math.round(v) : v.toFixed(1)}\u00A0${units[unit]}`;
};

export const formatRate = (value: number) => `${formatBytes(value)}/s`;

export const formatElapsed = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
};

export const formatDuration = (seconds: number): string => {
    // Sub-second calls have exact event-derived durations; "0s" would hide them.
    if (seconds > 0 && seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`;
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
};

const formatClock = (epochSec: number) =>
    new Date(epochSec * 1000).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
    });

export type SeriesSpec = {
    key: string;
    label: string;
    color: string;
};

export const MetricChart = ({
    title,
    data,
    series,
    startAt,
    format,
    domainMax,
    integerTicks,
    compact,
    throttleBands,
}: {
    title: string;
    data: Record<string, number | null>[];
    series: SeriesSpec[];
    startAt: number;
    format: (v: number) => string;
    domainMax?: number;
    integerTicks?: boolean;
    compact?: boolean;
    throttleBands?: ThrottleBand[];
}) => (
    <div className="min-w-0">
        <div className="flex items-center justify-between">
            <span className="eyebrow">{title}</span>
            {(series.length > 1 || (throttleBands?.length ?? 0) > 0) && (
                <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
                    {series.length > 1 &&
                        series.map((s) => (
                            <span key={s.key} className="inline-flex items-center gap-1.5">
                                <span
                                    className="h-1.5 w-1.5 rounded-full"
                                    style={{ backgroundColor: s.color }}
                                />
                                {s.label}
                            </span>
                        ))}
                    {(throttleBands?.length ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1.5">
                            <ThrottleSwatch />
                            Throttled
                        </span>
                    )}
                </span>
            )}
        </div>
        <div className={compact ? "mt-2 h-36" : "mt-2 h-56"}>
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                    {(throttleBands?.length ?? 0) > 0 && (
                        <defs>
                            {/* Faint tint + diagonal hatch: reads as "blocked
                                span" on light and dark without drowning the
                                series line the way a solid wash does. */}
                            <pattern
                                id="burla-throttle-hatch"
                                patternUnits="userSpaceOnUse"
                                width={5}
                                height={5}
                                patternTransform="rotate(45)"
                            >
                                <rect width={5} height={5} fill={THROTTLE} fillOpacity={0.07} />
                                <line
                                    x1={0}
                                    y1={0}
                                    x2={0}
                                    y2={5}
                                    stroke={THROTTLE}
                                    strokeWidth={1}
                                    strokeOpacity={0.28}
                                />
                            </pattern>
                        </defs>
                    )}
                    <CartesianGrid stroke="hsl(var(--border) / 0.5)" vertical={false} />
                    {throttleBands?.map((band) => (
                        <ReferenceArea
                            key={`${band.from}-${band.to}`}
                            x1={band.from}
                            x2={band.to}
                            ifOverflow="hidden"
                            fill="url(#burla-throttle-hatch)"
                            fillOpacity={0.45 + 0.55 * band.intensity}
                            stroke="none"
                        />
                    ))}
                    <XAxis
                        dataKey="t"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                        tickFormatter={(t) => formatElapsed(Number(t) - startAt)}
                        minTickGap={40}
                    />
                    <YAxis
                        width={64}
                        allowDecimals={!integerTicks}
                        domain={[0, domainMax ?? "auto"]}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                        tickFormatter={(v) => format(Number(v))}
                    />
                    <Tooltip
                        cursor={{ stroke: "hsl(var(--border))" }}
                        content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const throttledFraction = Number(
                                payload[0].payload?.throttled ?? 0
                            );
                            return (
                                <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-md">
                                    <div className="text-xs font-medium text-muted-foreground">
                                        {formatClock(Number(label))} (+
                                        {formatElapsed(Number(label) - startAt)})
                                    </div>
                                    {payload.map((entry) => (
                                        <div
                                            key={String(entry.dataKey)}
                                            className="mt-0.5 flex items-center gap-2 text-sm tabular-nums text-foreground"
                                        >
                                            <span
                                                className="h-1.5 w-1.5 rounded-full"
                                                style={{ backgroundColor: entry.color }}
                                            />
                                            {series.length > 1 && (
                                                <span className="text-xs text-muted-foreground">
                                                    {
                                                        series.find(
                                                            (s) => s.key === entry.dataKey
                                                        )?.label
                                                    }
                                                </span>
                                            )}
                                            <span className="font-medium">
                                                {format(Number(entry.value))}
                                            </span>
                                        </div>
                                    ))}
                                    {throttledFraction > 0 && (
                                        <div className="mt-0.5 flex items-center gap-2 text-sm tabular-nums text-foreground">
                                            <ThrottleSwatch />
                                            <span className="text-xs text-muted-foreground">
                                                Throttled
                                            </span>
                                            <span className="font-medium">
                                                {Math.round(throttledFraction * 100)}%
                                            </span>
                                        </div>
                                    )}
                                </div>
                            );
                        }}
                    />
                    {series.map((s) => (
                        <Area
                            key={s.key}
                            dataKey={s.key}
                            type="monotone"
                            stroke={s.color}
                            strokeWidth={1.5}
                            fill={s.color}
                            fillOpacity={0.08}
                            isAnimationActive={false}
                            connectNulls
                        />
                    ))}
                </AreaChart>
            </ResponsiveContainer>
        </div>
    </div>
);

export const ChartSkeletons = () => (
    <div className="space-y-7">
        {[0, 1, 2].map((i) => (
            <div key={i}>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-2 h-56 w-full" />
            </div>
        ))}
    </div>
);
