"""Compare every benchmark transcript with the generated source and write CSV/JSON.

Word error rate is token-level Levenshtein distance / reference token count.
Normalization lowercases, removes punctuation, and expands integers 0..99.
The synthetic corpus is a capacity probe, not a real-world accuracy benchmark.
"""
import argparse
import csv
import difflib
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--audio-directory', type=Path)
args = parser.parse_args()
root = args.directory.resolve()
audio = (args.audio_directory or root/'audio').resolve()
small = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
tens = 'zero ten twenty thirty forty fifty sixty seventy eighty ninety'.split()

def number(value):
    n = int(value)
    if n < 20: return small[n]
    if n < 100: return tens[n//10] + (' ' + small[n%10] if n%10 else '')
    return value

def tokens(text):
    text = re.sub(r'\b\d+\b', lambda m:number(m.group()), text.lower())
    return re.findall(r"[a-z]+|\d+", text)

def distance(reference, hypothesis):
    # Myers bit-vector edit distance: Python's arbitrary-precision integers make
    # exact long-transcript WER practical without a quadratic Python loop.
    m = len(reference)
    if not m: return len(hypothesis)
    masks = {}
    for i, token in enumerate(reference): masks[token] = masks.get(token, 0) | (1 << i)
    bound = (1 << m) - 1
    positive, negative, score = bound, 0, m
    for token in hypothesis:
        equal = masks.get(token, 0)
        x = equal | negative
        delta = (((x & positive) + positive) ^ positive) | x
        high_positive = negative | ~(delta | positive)
        high_negative = positive & delta
        score += ((high_positive >> (m-1)) & 1) - ((high_negative >> (m-1)) & 1)
        high_positive = (high_positive << 1) | 1
        high_negative <<= 1
        positive = (high_negative | ~(delta | high_positive)) & bound
        negative = (delta & high_positive) & bound
    return score

# Validate the analysis calculation independently against a basic DP oracle.
def oracle(a, b):
    previous = list(range(len(b)+1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(current[-1]+1, previous[j]+1, previous[j-1]+(x != y)))
        previous = current
    return previous[-1]
import itertools
sequences = [list(s) for n in range(4) for s in itertools.product('ab', repeat=n)]
for a in sequences:
    for b in sequences: assert distance(a,b) == oracle(a,b), (a,b)

rows = []
for case in sorted((root/'results').glob('*')):
    if not (case/'metrics.json').exists(): continue
    metric = json.loads((case/'metrics.json').read_text())
    resources = json.loads((case/'resources.json').read_text()) if (case/'resources.json').exists() else {}
    minutes = round(metric['audio_seconds']/60)
    manifest = json.loads((audio/f'{minutes:02d}min.json').read_text())
    reference = tokens((audio/f'{minutes:02d}min.txt').read_text())
    analyses = []
    for result in metric['runs']:
        transcript = (case/result['transcript_file']).read_text()
        hypothesis = tokens(transcript)
        count = distance(reference, hypothesis)
        matches = difflib.SequenceMatcher(a=reference, b=hypothesis, autojunk=False).get_matching_blocks()
        matched = set(i for block in matches for i in range(block.a, block.a+block.size))
        flattened = ' ' + ' '.join(hypothesis) + ' '
        markers = [s['marker'] for s in manifest['sections'] if ' '+' '.join(tokens(s['marker']))+' ' in flattened]
        sections = []
        start = 0
        for section in manifest['sections']:
            length = len(tokens(section['text']))
            coverage = sum(i in matched for i in range(start, start+length))/length
            sections.append({'section':section['section'], 'aligned_word_coverage':coverage, 'closing_marker_present':section['marker'] in markers})
            start += length
        analysis = {'run':result['run'], 'reference_words':len(reference), 'output_words':len(hypothesis), 'word_edit_distance':count, 'word_error_rate':count/len(reference), 'aligned_word_coverage':len(matched)/len(reference), 'markers_found':len(markers), 'markers_expected':minutes, 'sections':sections}
        analyses.append(analysis)
        rows.append({
            'minutes':minutes, 'engine':metric['engine'], 'run':result['run'],
            'inference_seconds':round(result['inference_seconds'],4),
            'model_load_seconds':round(metric['model_load_seconds'],4),
            'audio_speedup':round(result['audio_speedup'],2),
            'average_cpu_percent_one_core_100':round(result['average_cpu_percent'],2),
            'peak_sampled_cpu_percent_one_core_100':round(resources.get('peak_sampled_cpu_percent',0),2),
            'process_peak_rss_mib':round(result['process_peak_rss_bytes']/2**20,2),
            'peak_physical_footprint_mib':round(result['memory']['peak_physical_footprint_bytes']/2**20,2) if result.get('memory') else None,
            'raw_audio_mib':round(metric['input_f32_bytes']/2**20,2),
            'word_error_percent':round(analysis['word_error_rate']*100,2),
            'aligned_reference_percent':round(analysis['aligned_word_coverage']*100,2),
            'minute_markers_found':len(markers), 'minute_markers_expected':minutes,
            'reference_words':len(reference), 'output_words':len(hypothesis),
            'error':result['error'], 'exit_code':resources.get('exit_code'),
        })
    (case/'accuracy.json').write_text(json.dumps(analyses, indent=2))
(root/'summary.json').write_text(json.dumps(rows, indent=2))
if rows:
    with (root/'summary.csv').open('w') as f:
        writer=csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
for row in rows:
    if row['run'] == 2:
        print(f"{row['minutes']:2d}m {row['engine']:8s}: {row['inference_seconds']:7.2f}s CPU {row['average_cpu_percent_one_core_100']:6.1f}% RSS {row['process_peak_rss_mib']:7.1f}MiB WER {row['word_error_percent']:5.2f}% markers {row['minute_markers_found']}/{row['minute_markers_expected']}")
