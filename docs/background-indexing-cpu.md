# Background indexing CPU policy

The document-index **child process** is restricted; the Electron UI is not pinned.
Thread counts are ceilings, not promises of total application CPU utilization.

| Situation                                           | Threads                                          | Windows priority |
| --------------------------------------------------- | ------------------------------------------------ | ---------------- |
| Fast, idle on AC                                    | Up to floor(80% of available logical processors) | Below normal     |
| Fast, user active                                   | Up to 3, within the same ceiling                 | Idle             |
| Balanced, user active                               | Up to 2, within the same ceiling                 | Idle             |
| Sign-in launch with `GENOFFICE_INDEX_MAX_THREADS=1` | 1                                                | Idle             |

Memory-tier, battery, thermal, suspend and explicit pause protection still apply.
The existing governor waits for stable idleness before increasing work. The monitor
checks activity every five seconds; an in-flight native batch is not forcibly killed.
Model-specific thread limits can reduce these ceilings further.

## Windows placement

`GetSystemCpuSetInformation` reports the available CPU Set IDs, processor groups,
logical indices, shared physical-core indices and efficiency classes. Lower
efficiency classes are preferred only when Windows reports heterogeneous classes;
CPU numbering alone is never used to identify E-cores.

Among available E-cores, choose the highest logical indices first. On homogeneous
CPUs, choose the highest logical indices while leaving at least 20% of complete
physical cores unused where possible. Both paths also respect the logical-CPU
ceiling and the current requested thread count. A one-CPU machine necessarily
shares that CPU and relies on priority and duty-cycle limits instead.

Apply the IDs with `SetProcessDefaultCpuSets`, not a bit-shift affinity mask or a
process-wide restriction on the UI. Respect the target's existing processor-group
and affinity restrictions; skip parked, real-time and exclusively reserved CPUs.
If the selected E-core pool is smaller, reduce the worker's inference thread count
to match it. Placement updates are serialized, obsolete requests are ignored, and
the native helper holds the process handle to avoid PID-reuse races.

The bounded, hidden Windows PowerShell helper uses built-in Win32 APIs and adds no
package dependency. On older/restricted Windows hosts where it cannot run,
indexing retains its thread ceiling and low-priority policy. Other operating
systems retain their existing priority/duty-cycle behavior; this change does not
claim E-core pinning on those systems.

## Deployment and enterprise limits

On dntn27 (4 physical / 8 logical CPUs, no E-cores), Fast/idle selects logical CPUs
2–7, leaving the physical core containing CPUs 0–1 available. A sign-in launch
selects CPU 7 only. The sign-in launcher should set the launch ceiling rather than
restricting the entire Electron process and its UI.

This reduces interference; it cannot guarantee zero impact. Memory bandwidth,
storage I/O, OCR outside the index child and other background work still share
machine resources. A CPU Set is not a hard job-object CPU quota. NUMA placement
and performance on heterogeneous enterprise hardware require measurement rather
than assuming a larger CPU index is physically farther away or faster.

References: [CPU Sets](https://learn.microsoft.com/en-us/windows/win32/procthread/cpu-sets),
[efficiency-class semantics](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-system_cpu_set_information),
[default CPU Sets](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessdefaultcpusets).
