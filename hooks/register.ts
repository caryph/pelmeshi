import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pelmeshi',
      description: 'Export current session to .llm/ (optional comment)',
    })

    return next(e)
  })

  on('command.run', { command: 'pelmeshi' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const argv = [
      'node', `${$.plugin.root}/src/convert.ts`,
      '--claude-session', await $.session.id(),
      '-o', `${cwd}/.llm`,
      '--comment', e.args.trim(),
    ]
    $.ui.status('pelmeshi: exporting…')
    try {
      const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd, timeoutMs: 60_000 })
      if (exitCode !== 0) return { text: stderr.trim() || `pelmeshi exited with ${exitCode}` }
      const warnings = stderr.trim()

      return { text: `exported -> ${stdout.trim()}${warnings ? `\n${warnings}` : ''}` }
    } catch (err) {
      return { text: `pelmeshi failed: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      $.ui.status(undefined)
    }
  })
}
