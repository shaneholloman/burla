import { useCallback, useEffect, useRef, useState } from "react";
import { BurlaJob } from "@/types/coreTypes";
import { createNewJob } from "@/contexts/JobsContext";
import { JobsTable } from "@/components/JobsList";
import { managementEvents, managementJson } from "@/lib/managementApi";

const PAGE_SIZE = 15;

// The jobs nested directly inside one job: rendered on its detail page,
// hidden entirely while the job has none. Remount (via key) when jobId
// changes so no state leaks between jobs.
export const NestedJobs = ({ jobId }: { jobId: string }) => {
    const [jobs, setJobs] = useState<BurlaJob[]>([]);
    const [page, setPage] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [totalCount, setTotalCount] = useState(0);
    const [hasLoaded, setHasLoaded] = useState(false);
    const pageCursors = useRef<Record<number, string | null>>({ 0: null });

    const fetchJobs = useCallback(async () => {
        try {
            const cursor = pageCursors.current[page];
            const query = new URLSearchParams({
                parent_job_id: jobId,
                limit: String(PAGE_SIZE),
                sort: "started_at",
                order: "desc",
            });
            if (cursor) query.set("cursor", cursor);
            const json = await managementJson<any>(`/jobs?${query}`);
            const jobList = (json.items ?? []).map(createNewJob);
            setJobs(jobList);
            pageCursors.current[page + 1] = json.next_cursor;
            setTotalCount(json.total_count ?? jobList.length);
            setTotalPages(Math.max(1, Math.ceil((json.total_count ?? jobList.length) / PAGE_SIZE)));
        } catch (err) {
            console.error("Error fetching nested jobs:", err);
        } finally {
            setHasLoaded(true);
        }
    }, [jobId, page]);

    useEffect(() => {
        fetchJobs();
    }, [fetchJobs]);

    useEffect(() => {
        const update = (data: any) => {
            if (page !== 0) return;
            const newJob = createNewJob(data);
            setJobs((previous) => {
                const without = previous.filter((job) => job.id !== newJob.id);
                if (without.length === previous.length) {
                    setTotalCount((count) => count + 1);
                }
                return [newJob, ...without]
                    .sort(
                        (a, b) =>
                            (b.started_at?.getTime() || 0) - (a.started_at?.getTime() || 0)
                    )
                    .slice(0, PAGE_SIZE);
            });
        };
        const source = managementEvents(
            `/jobs/watch?parent_job_id=${encodeURIComponent(jobId)}`,
            {
                snapshot: (data) => {
                    const items = data.items ?? [];
                    setTotalCount((count) => Math.max(count, items.length));
                    if (page === 0) setJobs(items.slice(0, PAGE_SIZE).map(createNewJob));
                },
                update,
            }
        );
        return () => {
            source.close();
        };
    }, [jobId, page]);

    if (!hasLoaded || totalCount === 0) return null;

    return (
        <div className="mb-4">
            <div className="mb-2 flex items-baseline gap-2">
                <h2 className="text-sm font-semibold text-foreground">Nested jobs</h2>
                <span className="text-[13px] tabular-nums text-muted-foreground">
                    {totalCount.toLocaleString()}
                </span>
            </div>
            <JobsTable
                jobs={jobs}
                isLoading={false}
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
                emptyState={null}
            />
        </div>
    );
};
