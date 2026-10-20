import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

const DEFAULT_TAIL = 200

export const getJobLog = defineTool({
  name: 'get_job_log',
  description:
    'Read the log of one job as plain text: the last `tail` lines (default 200, max 5000), oldest first, each prefixed with its timestamp. ' +
    'While the job runs the lines come from the runner container live; after it finishes they are replaced by the log GitHub stores for the job. ' +
    'The first line reports source (runner | github | collecting), truncation and whether more lines may still arrive. ' +
    'Use list_jobs to find the job id.',
  inputSchema: {
    job_id: z.number().int().min(1),
    tail: z.number().int().min(1).max(5000).optional(),
  },
  destructive: false,
  handler: async ({ job_id, tail }) => {
    const log = await service.getJobLog(job_id, { tail: tail ?? DEFAULT_TAIL })
    const header = `# job ${job_id}: source=${log.source ?? 'collecting'} truncated=${log.truncated} complete=${log.complete} lines=${log.lines.length}`
    return [header, ...log.lines.map((l) => `${l.at} ${l.line}`)].join('\n')
  },
})
