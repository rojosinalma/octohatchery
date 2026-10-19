import { adoptRepo } from './adopt_repo'
import { applyRunsOn } from './apply_runs_on'
import type { ToolDefinition } from './define'
import { deleteRunnerType } from './delete_runner_type'
import { getSettings } from './get_settings'
import { health } from './health'
import { kill } from './kill'
import { listEvents } from './list_events'
import { listHosts } from './list_hosts'
import { listJobs } from './list_jobs'
import { listRepos } from './list_repos'
import { listRunnerTypes } from './list_runner_types'
import { listRunners } from './list_runners'
import { listSlots } from './list_slots'
import { setSetting } from './set_setting'
import { setSlots } from './set_slots'
import { spawn } from './spawn'
import { unadoptRepo } from './unadopt_repo'
import { upsertRunnerType } from './upsert_runner_type'

/** Every MCP tool. Adding a tool = one file in this folder + one line here. */
// Widened on purpose: each tool keeps its own input shape, the registry only needs the common surface.
export const tools: ToolDefinition[] = [
  listHosts,
  listRunnerTypes,
  upsertRunnerType,
  deleteRunnerType,
  listSlots,
  setSlots,
  listRepos,
  adoptRepo,
  unadoptRepo,
  applyRunsOn,
  listJobs,
  listRunners,
  spawn,
  kill,
  listEvents,
  getSettings,
  setSetting,
  health,
] as ToolDefinition[]

export const findTool = (name: string): ToolDefinition | undefined => tools.find((t) => t.name === name)
