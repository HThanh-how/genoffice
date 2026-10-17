import { app } from 'electron'
import {
  markSheetsShuttingDown,
  resetSheetsShuttingDown,
  setInteractiveQuitCoordination,
} from '../../../sheets/src/main/sheets-main'

/**
 * Coordinates application shutdown across macOS, Windows and Linux.
 * Preserves the user's explicit Quit intent across asynchronous close-confirmation
 * dialogs without leaving orphan processes or forcing abnormal process termination.
 */
export class QuitCoordinator {
  private quitInProgress = false
  private quitConfirmed = false
  private promptInFlight = false

  constructor() {
    try {
      setInteractiveQuitCoordination(true)
    } catch {
      // ignore in tests where sheets module is not loaded
    }
  }

  public isQuitting(): boolean {
    return this.quitInProgress
  }

  public isConfirmed(): boolean {
    return this.quitConfirmed
  }

  public isPromptInFlight(): boolean {
    return this.promptInFlight
  }

  public setPromptInFlight(inFlight: boolean): void {
    this.promptInFlight = inFlight
  }

  public setQuitInProgress(inProgress: boolean): void {
    this.quitInProgress = inProgress
  }

  public abortQuit(): void {
    this.quitInProgress = false
    this.quitConfirmed = false
    this.promptInFlight = false
    try {
      resetSheetsShuttingDown()
    } catch {
      // ignore
    }
  }

  public confirmQuit(): void {
    this.quitConfirmed = true
    this.promptInFlight = false
    try {
      markSheetsShuttingDown()
    } catch {
      // ignore
    }
    app.quit()
  }
}

export const quitCoordinator = new QuitCoordinator()
