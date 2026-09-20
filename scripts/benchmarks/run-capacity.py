"""Run isolated local-engine cases and sample host/process resource usage.

Build stt_capacity with --release --features local-stt,parakeet first.
Inputs are generated locally by generate-capacity-audio.py; no network is used.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--binary', type=Path, default=Path('src-tauri/target/release/examples/stt_capacity'))
parser.add_argument('--models', type=Path, default=Path.home() / 'Library/Application Support/ai.linty.desktop/models')
parser.add_argument('--minutes', type=int, nargs='+', default=[1, 5, 10, 20, 30])
parser.add_argument('--runs', type=int, default=2)
parser.add_argument('--timeout', type=float, default=900)
parser.add_argument('--max-rss-gib', type=float, default=8)
args = parser.parse_args()
root = args.directory.resolve()
binary = args.binary.resolve()
root.mkdir(parents=True, exist_ok=True)

def command(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    return {'exit_code':result.returncode, 'output':result.stdout.strip(), 'error':result.stderr.strip()}

def system():
    return {
        'at':time.time(), 'load_average':os.getloadavg(),
        'swap':command('sysctl', 'vm.swapusage'),
        'vm_stat':command('vm_stat'),
        'memory_pressure':command('memory_pressure', '-Q'),
        'thermal':command('pmset', '-g', 'therm'),
    }

# Fixed Darwin rusage_info_v6 ABI from sys/resource.h. Older systems fall
# back to v4; newer counters then remain unavailable instead of reporting zero.
class DarwinUsage(ctypes.Structure):
    _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in """
        ri_user_time ri_system_time ri_pkg_idle_wkups ri_interrupt_wkups ri_pageins
        ri_wired_size ri_resident_size ri_phys_footprint ri_proc_start_abstime
        ri_proc_exit_abstime ri_child_user_time ri_child_system_time
        ri_child_pkg_idle_wkups ri_child_interrupt_wkups ri_child_pageins
        ri_child_elapsed_abstime ri_diskio_bytesread ri_diskio_byteswritten
        ri_cpu_time_qos_default ri_cpu_time_qos_maintenance ri_cpu_time_qos_background
        ri_cpu_time_qos_utility ri_cpu_time_qos_legacy ri_cpu_time_qos_user_initiated
        ri_cpu_time_qos_user_interactive ri_billed_system_time ri_serviced_system_time
        ri_logical_writes ri_lifetime_max_phys_footprint ri_instructions ri_cycles
        ri_billed_energy ri_serviced_energy ri_interval_max_phys_footprint ri_runnable_time
        ri_flags ri_user_ptime ri_system_ptime ri_pinstructions ri_pcycles ri_energy_nj
        ri_penergy_nj ri_secure_time_in_system ri_secure_ptime_in_system
        ri_neural_footprint ri_lifetime_max_neural_footprint ri_interval_max_neural_footprint
    """.split()] + [('ri_reserved', ctypes.c_uint64 * 9)]

libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
libproc.proc_pid_rusage.restype = ctypes.c_int

def darwin_usage(pid):
    value = DarwinUsage()
    for version in [6, 4]:
        if libproc.proc_pid_rusage(pid, version, ctypes.byref(value)) == 0:
            fields = ['ri_phys_footprint', 'ri_lifetime_max_phys_footprint', 'ri_resident_size', 'ri_diskio_bytesread', 'ri_diskio_byteswritten']
            if version == 6:
                fields += ['ri_neural_footprint', 'ri_lifetime_max_neural_footprint', 'ri_energy_nj']
            return {'version':version, **{k:getattr(value,k) for k in fields}}
    return None

def cpu_time(value):
    total = 0.0
    for part in value.split(':'): total = total * 60 + float(part)
    return total

sources = ['src-tauri/src/transcribe.rs','src-tauri/src/parakeet.rs','src-tauri/swift/Sources/LintyParakeet/Bridge.swift','src-tauri/Cargo.lock']
environment = {
    'hardware':command('sysctl','machdep.cpu.brand_string','hw.memsize','hw.physicalcpu','hw.logicalcpu','hw.perflevel0.physicalcpu','hw.perflevel1.physicalcpu'),
    'os':command('sw_vers'), 'power':command('pmset','-g','batt'),
    'git_head':command('git','rev-parse','HEAD'),
    'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
    'source_sha256':{p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in sources},
    'profile':'release', 'sample_interval_seconds':0.5,
    'runs_per_case':args.runs, 'timeout_seconds':args.timeout, 'max_rss_gib':args.max_rss_gib,
    'initial_system':system(),
}
(root/'environment.json').write_text(json.dumps(environment, indent=2))

outcomes = []
for minutes in args.minutes:
    for engine in ['whisper','parakeet']:
        case = root / 'results' / f'{minutes:02d}min-{engine}'
        case.mkdir(parents=True, exist_ok=True)
        if (case/'metrics.json').exists():
            raise RuntimeError(f'Refusing to overwrite completed case: {case}')
        wav = root/'audio'/f'{minutes:02d}min.wav'
        before = system()
        samples = []
        peak_cpu = 0.0
        peak_rss = 0
        reason = None
        stage = 'startup'
        previous = None
        print(f'START {minutes}min {engine}', flush=True)
        with (case/'stdout.log').open('w') as stdout, (case/'stderr.log').open('w') as stderr:
            process = subprocess.Popen([str(binary), engine, str(args.models), str(wav), str(case), str(args.runs)], stdout=stdout, stderr=stderr)
            start = time.monotonic()
            offset = 0
            while process.poll() is None:
                observed = time.monotonic()
                with (case/'stdout.log').open() as progress:
                    progress.seek(offset)
                    for line in progress:
                        if not line.startswith('CAPACITY '): continue
                        try: event = json.loads(line[len('CAPACITY '):])
                        except json.JSONDecodeError: continue
                        stage = event['event'] + (f"-{event['run']}" if 'run' in event else '')
                        if event['event'] == 'inference_complete':
                            result = event['result']
                            print(f"DONE {minutes}min {engine} run {result['run']}: {result['inference_seconds']:.2f}s, CPU {result['average_cpu_percent']:.1f}%, peak RSS {result['process_peak_rss_bytes']/2**30:.2f} GiB, {result['word_count']} words", flush=True)
                    offset = progress.tell()
                status = command('ps','-p',str(process.pid),'-o','rss=,time=,%cpu=,state=')
                fields = status['output'].split()
                if len(fields) >= 4:
                    rss = int(fields[0]) * 1024
                    cpu = cpu_time(fields[1])
                    interval_cpu = None
                    if previous and observed > previous[0]:
                        interval_cpu = max(0.0, (cpu - previous[1]) / (observed - previous[0]) * 100)
                        peak_cpu = max(peak_cpu, interval_cpu)
                    previous = (observed, cpu)
                    peak_rss = max(peak_rss, rss)
                    samples.append({'elapsed_seconds':observed-start, 'stage':stage, 'rss_bytes':rss, 'cpu_seconds':cpu, 'interval_cpu_percent':interval_cpu, 'ps_cpu_percent':float(fields[2]), 'state':fields[3], 'darwin_usage':darwin_usage(process.pid)})
                    if rss > args.max_rss_gib * 2**30: reason = 'benchmark memory guard'
                if observed-start > args.timeout: reason = 'benchmark timeout'
                if reason:
                    process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait()
                    break
                time.sleep(0.5)
            code = process.wait()
        report = {'exit_code':code, 'stop_reason':reason, 'process_wall_seconds':time.monotonic()-start, 'peak_sampled_cpu_percent':peak_cpu, 'peak_sampled_rss_bytes':peak_rss, 'samples':samples, 'before':before, 'after':system()}
        (case/'resources.json').write_text(json.dumps(report, indent=2))
        outcomes.append({'minutes':minutes, 'engine':engine, 'exit_code':code, 'stop_reason':reason, 'metrics_written':(case/'metrics.json').exists()})
        print(f'CASE {minutes}min {engine}: exit {code}, sampled peak CPU {peak_cpu:.1f}%, RSS {peak_rss/2**30:.2f} GiB', flush=True)
successful = all(case['exit_code'] == 0 and case['stop_reason'] is None and case['metrics_written'] for case in outcomes)
(root/'completed.json').write_text(json.dumps({'finished_at':time.time(), 'all_successful':successful, 'cases':outcomes, 'final_system':system()}, indent=2))
print('All capacity cases finished.' if successful else 'Capacity cases finished with failures; inspect resources.json.', flush=True)
sys.exit(0 if successful else 1)
