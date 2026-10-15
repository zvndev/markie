export interface DocumentCommandTarget {
  modalOpen?: boolean;
  /** Only commands the active renderer can perform in its current state. */
  enabledCommands: readonly string[];
  execute(command: string): void;
}
