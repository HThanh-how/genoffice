import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { selectBackgroundCpuSets, type BackgroundCpuSet } from './background-cpu'

// Use CPU Set IDs rather than a 64-bit affinity mask (IDs also identify processor groups).
// The helper holds the target handle until assignment, so PID reuse cannot retarget it.
export const WINDOWS_CPU_SET_API = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class GenOfficeCpuSets {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetSystemCpuSetInformation(IntPtr info, uint length, out uint needed, IntPtr process, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetProcessDefaultCpuSets(IntPtr process, uint[] ids, uint count);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessGroupAffinity(IntPtr process, ref ushort count, ushort[] groups);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessAffinityMask(IntPtr process, out UIntPtr mask, out UIntPtr system);
  public class Cpu { public uint id; public ushort group; public byte index; public byte core; public byte efficiencyClass; }
  public static Cpu[] Read(IntPtr process) {
    ushort groupCount=64; ushort[] groups=new ushort[groupCount];
    if (!GetProcessGroupAffinity(process, ref groupCount, groups)) throw new Exception("CPU groups unavailable");
    UIntPtr mask=UIntPtr.Zero, system=UIntPtr.Zero; bool restricted=groupCount==1 && GetProcessAffinityMask(process, out mask, out system);
    ulong allowed=restricted ? mask.ToUInt64() : ulong.MaxValue;
    uint needed; GetSystemCpuSetInformation(IntPtr.Zero, 0, out needed, process, 0);
    if (needed==0 || needed>1048576) throw new Exception("Invalid CPU topology size");
    IntPtr buffer=Marshal.AllocHGlobal((int)needed);
    try {
      uint length=needed;
      if (!GetSystemCpuSetInformation(buffer, length, out needed, process, 0)) throw new Exception("CPU topology unavailable");
      var result=new List<Cpu>();
      for (int offset=0; offset+8<=needed;) {
        IntPtr entry=IntPtr.Add(buffer, offset); int size=Marshal.ReadInt32(entry); int type=Marshal.ReadInt32(entry,4);
        if (size<8 || offset+size>needed) throw new Exception("Invalid CPU topology record");
        if (type==0 && size>=20) {
          ushort group=(ushort)Marshal.ReadInt16(entry,12); byte index=Marshal.ReadByte(entry,14); byte flags=Marshal.ReadByte(entry,19);
          bool inGroup=false; for(int g=0;g<groupCount;g++) if(groups[g]==group) inGroup=true;
          if (inGroup && index<64 && (!restricted || (allowed & (1UL<<index))!=0) && (flags & 9)==0 && ((flags & 2)==0 || (flags & 4)!=0))
            result.Add(new Cpu {id=(uint)Marshal.ReadInt32(entry,8),group=group,index=index,core=Marshal.ReadByte(entry,15),efficiencyClass=Marshal.ReadByte(entry,18)});
        }
        offset+=size;
      }
      return result.ToArray();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
`

/** Best effort: unsupported/restricted Windows hosts retain the existing low-priority policy. */
export function placeBackgroundProcess(pid: number, threads: number): Promise<number | undefined> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0)
    return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const script =
      `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOWS_CPU_SET_API}\n'@\n` +
      `$h=[GenOfficeCpuSets]::OpenProcess(0x1600,$false,${pid}); if($h -eq [IntPtr]::Zero){exit 1}; try { ` +
      `ConvertTo-Json -InputObject @([GenOfficeCpuSets]::Read($h)) -Compress; ` +
      `$line=[Console]::ReadLine(); if($line){[uint32[]]$ids=@($line.Split(',') | ForEach-Object {[uint32]$_}); ` +
      `if(-not [GenOfficeCpuSets]::SetProcessDefaultCpuSets($h,$ids,$ids.Length)){exit 1}} ` +
      `} finally {[void][GenOfficeCpuSets]::CloseHandle($h)}`
    const exe = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const child = spawn(
      exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    )
    let output = '',
      selected: number[] | undefined,
      settled = false
    const finish = (count?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(count)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish()
    }, 8000)
    timer.unref?.()
    child.stdin.on('error', () => finish())
    child.on('error', () => finish())
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (part: string) => {
      output += part
      if (output.length > 256 * 1024) {
        child.kill()
        finish()
        return
      }
      if (selected || !output.includes('\n')) return
      try {
        const cpus: BackgroundCpuSet[] = JSON.parse(
          output
            .slice(0, output.indexOf('\n'))
            .replace(/^\uFEFF/, '')
            .trim(),
        )
        if (
          !Array.isArray(cpus) ||
          cpus.some(
            (cpu) =>
              !['id', 'group', 'index', 'core', 'efficiencyClass'].every(
                (key) =>
                  Number.isSafeInteger(cpu[key as keyof BackgroundCpuSet]) &&
                  cpu[key as keyof BackgroundCpuSet] >= 0,
              ),
          )
        )
          throw new Error('Invalid CPU topology')
        selected = selectBackgroundCpuSets(cpus, threads)
        child.stdin.end(selected.join(',') + '\n')
      } catch {
        child.kill()
        finish()
      }
    })
    child.on('close', (code) =>
      finish(code === 0 && selected?.length ? selected.length : undefined),
    )
  })
}
