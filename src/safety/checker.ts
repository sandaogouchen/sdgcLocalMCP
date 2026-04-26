import { CommandRequest, SafetyCheckResult, ServerConfig } from '../types/index.js';

export class SafetyChecker {
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  check(command: string, _request: CommandRequest): SafetyCheckResult {
    const blockedPatterns = this.checkBlockedPatterns(command);
    if (blockedPatterns.length > 0) {
      return {
        allowed: false,
        riskLevel: 'critical',
        reason: `Command blocked: ${blockedPatterns.join(', ')}`,
        requiresConfirmation: false,
        blockedPatterns,
      };
    }

    const riskLevel = this.assessRiskLevel(command);
    const requiresConfirmation = this.requiresConfirmation(command);

    return {
      allowed: true,
      riskLevel,
      reason: this.getRiskReason(riskLevel, command),
      requiresConfirmation,
    };
  }

  private checkBlockedPatterns(command: string): string[] {
    const lowerCommand = command.toLowerCase();
    const matched: string[] = [];

    for (const pattern of this.config.blockedCommands) {
      if (lowerCommand.includes(pattern.toLowerCase())) {
        matched.push(pattern);
      }
    }

    return matched;
  }

  private assessRiskLevel(command: string): 'low' | 'medium' | 'high' | 'critical' {
    const lowerCmd = command.toLowerCase();

    if (/rm\s+-rf\s+\/(\s|$)/.test(lowerCmd)) {
      return 'critical';
    }
    if (/\b(sudo|su|chmod\s+777|chown\s+-r)\b/.test(lowerCmd)) {
      return 'high';
    }
    if (/\b(curl|wget)\b.*(\||;|\s+sh\s)/.test(lowerCmd)) {
      return 'high';
    }
    if (/^\s*(cat|ls|echo|pwd|whoami|date)\b/.test(lowerCmd)) {
      return 'low';
    }

    return 'medium';
  }

  private requiresConfirmation(command: string): boolean {
    const lowerCmd = command.toLowerCase();

    for (const pattern of this.config.requireConfirmationPatterns) {
      if (lowerCmd.includes(pattern.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  private getRiskReason(riskLevel: SafetyCheckResult['riskLevel'], command: string): string {
    switch (riskLevel) {
      case 'low':
        return 'Read-only command';
      case 'medium':
        return 'May modify system state';
      case 'high':
        return 'Elevated-risk command';
      case 'critical':
        return `Critical operation detected: ${command}`;
      default:
        return 'Unknown';
    }
  }
}
