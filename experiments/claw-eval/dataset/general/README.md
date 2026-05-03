# claw-eval general asset bundle

This directory is intentionally not committed because the flattened `general` asset bundle is large.

Expected local layout:

- `experiments/claw-eval/dataset/general/*.json`
- other flattened task assets provided by the official `general` bundle

The current claw-eval adapter resolves general assets from this directory by default.

## How to populate

Download the official `general` data bundle used with claw-eval and extract/copy its contents into this directory so that files look like:

- `001_00_t001zh_email_triage.json`
- `029_02_t029zh_cross_service_meeting.json`
- `093_00_t096_pinbench_business_metrics_summary.xlsx`
- etc.

If you already have the bundle on an existing machine, a direct copy works:

```bash
rsync -a /path/to/general/ experiments/claw-eval/dataset/general/
```

## Notes

- Do not rename files. The adapter relies on the flattened filename convention.
- This repo keeps only this README under `dataset/general/`; the data files are ignored by Git.
