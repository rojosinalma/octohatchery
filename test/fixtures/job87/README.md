# Job log fixture

One GitHub Actions job (`lint`) in the documented shape of GitHub's run-attempt log archive
(`GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}/logs`): one flat file per job at the top
(`0_<job>.txt`) and, in a folder named after the job, one file per step (`<job>/<number>_<step name>.txt`)
plus `system.txt`. Many archives GitHub hands out today hold only the flat file and `system.txt`; the
per-step files here cover the path for archives that have them, the flat file covers the split by time.
Repository and host names are replaced by `acme/widgets` and `node-a`.

The case it covers: the `Standard` step prints all its output in the same second the next steps start,
so splitting the flat log by step timestamps alone puts that output under `Complete job`. The per-step
files keep it under `Standard`, and so does the split by time and step openers.
