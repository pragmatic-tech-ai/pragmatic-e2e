import { execFile, spawn } from 'node:child_process'

/** What a finished program answered: its exit code and its output (the caller decides what of it may be logged). */
export class ProcessResult
{
    public constructor(public readonly Code: number, public readonly Stdout: string, public readonly Stderr: string)
    {
    }

    public get Ok(): boolean
    {
        return this.Code === 0
    }
}

/** Runs a program with an argument vector (never a shell string); a fake in leg tests. */
export interface IProcessRunner
{
    /** Runs to its end; an aborted `signal` kills the program, and the promise still settles only once it has exited. */
    Run(program: string, argv: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult>
}

/** A program started and left running (a port-forward): stopped by the owner, awaited until it exited. */
export interface IRunningProcess
{
    /** Kills the program and settles once it has exited (at once when it already has). */
    Stop(): Promise<void>
}

/** Starts a long-lived program without awaiting it; a fake in leg tests. */
export interface IProcessStarter
{
    /** Spawns `program` (no shell, output discarded); `onExit` is called with its exit code when it ends, however it ends. */
    Start(program: string, argv: readonly string[], onExit: (code: number) => void): IRunningProcess
}

/** A node child process left running. */
class NodeRunningProcess implements IRunningProcess
{
    private static readonly KillSignal = 'SIGTERM'
    private static readonly ExitEvent = 'exit'
    private static readonly ErrorEvent = 'error'
    private static readonly Failed = 1

    private readonly exited: Promise<void>

    public constructor(private readonly child: ReturnType<typeof spawn>, onExit: (code: number) => void)
    {
        const N = NodeRunningProcess
        this.exited = new Promise(resolve =>
        {
            // A program that cannot start emits 'error' (and no 'exit'); both count as the end.
            child.once(N.ErrorEvent, () =>
            {
                onExit(N.Failed)
                resolve()
            })
            child.once(N.ExitEvent, code =>
            {
                onExit(code ?? N.Failed)
                resolve()
            })
        })
    }

    public async Stop(): Promise<void>
    {
        if (this.child.exitCode === null && this.child.signalCode === null)
        {
            this.child.kill(NodeRunningProcess.KillSignal)
        }
        await this.exited
    }
}

/**
 * IProcessRunner over node's execFile: no shell, so nothing in an argument is re-read; output capped; a program that
 * runs past its deadline, or whose signal aborts, is killed and answers a non-zero code. execFile answers an abort
 * before the child is gone, so the call waits for the child's own exit before it settles: nothing outlives it. Never
 * throws for a failed program.
 */
export class NodeProcessRunner implements IProcessRunner, IProcessStarter
{
    private static readonly MaxBuffer = 32 * 1024 * 1024
    private static readonly Encoding = 'utf8'
    private static readonly Failed = 1
    private static readonly KillSignal = 'SIGTERM'
    private static readonly ExitEvent = 'exit'
    private static readonly Ignore = 'ignore'

    public Start(program: string, argv: readonly string[], onExit: (code: number) => void): IRunningProcess
    {
        const child = spawn(program, [...argv], { stdio: NodeProcessRunner.Ignore, windowsHide: true })
        return new NodeRunningProcess(child, onExit)
    }

    public Run(program: string, argv: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult>
    {
        const N = NodeProcessRunner
        return new Promise(resolve =>
        {
            const child = execFile(program, [...argv], { encoding: N.Encoding, maxBuffer: N.MaxBuffer, timeout: timeoutMs, windowsHide: true, signal, killSignal: N.KillSignal }, (error, stdout, stderr) =>
            {
                const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : N.Failed
                const result = new ProcessResult(code, stdout, stderr)
                if (child.exitCode !== null || child.signalCode !== null)
                {
                    resolve(result)
                    return
                }
                child.once(N.ExitEvent, () => resolve(result))
            })
        })
    }
}
