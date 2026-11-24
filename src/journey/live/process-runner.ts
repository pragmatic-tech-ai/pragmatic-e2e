import { execFile } from 'node:child_process'

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
    Run(program: string, argv: readonly string[], timeoutMs: number): Promise<ProcessResult>
}

/**
 * IProcessRunner over node's execFile: no shell, so nothing in an argument is re-read; output capped; a program that
 * runs past its deadline is killed and answers a non-zero code. Never throws for a failed program.
 */
export class NodeProcessRunner implements IProcessRunner
{
    private static readonly MaxBuffer = 32 * 1024 * 1024
    private static readonly Encoding = 'utf8'
    private static readonly Failed = 1

    public Run(program: string, argv: readonly string[], timeoutMs: number): Promise<ProcessResult>
    {
        const N = NodeProcessRunner
        return new Promise(resolve =>
        {
            execFile(program, [...argv], { encoding: N.Encoding, maxBuffer: N.MaxBuffer, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) =>
            {
                const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : N.Failed
                resolve(new ProcessResult(code, stdout, stderr))
            })
        })
    }
}
