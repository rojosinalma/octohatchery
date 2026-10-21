# Job log fixture

`lint.txt` is one GitHub Actions job (`lint`) as GitHub's job log endpoint returns it
(`GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`): one flat file, 509 lines, each step's output
after the previous one, every step after the first starting with a byte-order mark.
Repository and host names are replaced by `acme/widgets` and `node-a`.

The case it covers: the `Standard` step prints all its output in the same second the next steps start,
so splitting the log by step timestamps alone puts that output under `Complete job`. The split by time
and step openers keeps it under `Standard`.
