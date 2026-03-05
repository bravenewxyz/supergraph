import type { Contract } from "../schema/contracts.js";
import type { GraphStore } from "../store/graph-store.js";

export interface AgentContractView {
  ownedContracts: Contract[];
  dependencyContracts: Contract[];
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  symbolId: string;
  contractField: string;
  expected: string;
  actual: string;
}

export interface ChangeProposal {
  id: string;
  symbolId: string;
  agentId: string;
  oldSignature: string;
  newSignature: string;
  reason: string;
  impactedSymbols: string[];
  status: "pending" | "approved" | "rejected";
}

export class ContractLayer {
  private contracts: Map<string, Contract>; // symbolId -> Contract
  private assignments: Map<string, string>; // symbolId -> agentId
  private proposals: Map<string, ChangeProposal>; // proposalId -> ChangeProposal

  constructor(private graphStore: GraphStore) {
    this.contracts = new Map();
    this.assignments = new Map();
    this.proposals = new Map();
  }

  // --- Contract management ---

  defineContract(contract: Contract): void {
    this.contracts.set(contract.symbolId, contract);
  }

  defineContractsFromGraph(): void {
    const allSymbols = this.graphStore.getAllSymbols();
    for (const sym of allSymbols) {
      if (!sym.exported) continue;
      const deps = this.graphStore.getDependencies(sym.id);
      const contract: Contract = {
        symbolId: sym.id,
        kind: sym.kind,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        signature: sym.signature,
        exported: sym.exported,
        dependencies: deps,
      };
      this.contracts.set(sym.id, contract);
    }
  }

  getContract(symbolId: string): Contract | undefined {
    return this.contracts.get(symbolId);
  }

  getAllContracts(): Contract[] {
    return [...this.contracts.values()];
  }

  // --- Assignment ---

  assignContract(symbolId: string, agentId: string): void {
    this.assignments.set(symbolId, agentId);
  }

  getAgentView(agentId: string): AgentContractView {
    const ownedContracts: Contract[] = [];
    const depSymbolIds = new Set<string>();

    // Find all contracts assigned to this agent
    for (const [symbolId, assignedAgent] of this.assignments) {
      if (assignedAgent === agentId) {
        const contract = this.contracts.get(symbolId);
        if (contract) {
          ownedContracts.push(contract);
          // Collect dependency symbol IDs
          for (const depId of contract.dependencies) {
            depSymbolIds.add(depId);
          }
        }
      }
    }

    // Remove owned symbols from dependency set (no self-references)
    for (const owned of ownedContracts) {
      depSymbolIds.delete(owned.symbolId);
    }

    // Build dependency contracts (signature only — no body exposure)
    const dependencyContracts: Contract[] = [];
    for (const depId of depSymbolIds) {
      const contract = this.contracts.get(depId);
      if (contract) {
        dependencyContracts.push(contract);
      }
    }

    return { ownedContracts, dependencyContracts };
  }

  getAssignedAgent(symbolId: string): string | undefined {
    return this.assignments.get(symbolId);
  }

  // --- Validation ---

  validateImplementation(symbolId: string): ValidationResult {
    const contract = this.contracts.get(symbolId);
    if (!contract) {
      return { valid: true, errors: [] };
    }

    const symbol = this.graphStore.getSymbol(symbolId);
    if (!symbol) {
      return {
        valid: false,
        errors: [
          {
            symbolId,
            contractField: "existence",
            expected: "symbol exists",
            actual: "symbol not found",
          },
        ],
      };
    }

    const errors: ValidationError[] = [];

    if (symbol.name !== contract.name) {
      errors.push({
        symbolId,
        contractField: "name",
        expected: contract.name,
        actual: symbol.name,
      });
    }

    if (symbol.signature !== contract.signature) {
      errors.push({
        symbolId,
        contractField: "signature",
        expected: contract.signature,
        actual: symbol.signature,
      });
    }

    if (symbol.exported !== contract.exported) {
      errors.push({
        symbolId,
        contractField: "exported",
        expected: String(contract.exported),
        actual: String(symbol.exported),
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  validateAll(): Map<string, ValidationResult> {
    const results = new Map<string, ValidationResult>();
    for (const symbolId of this.contracts.keys()) {
      results.set(symbolId, this.validateImplementation(symbolId));
    }
    return results;
  }

  // --- Change proposals ---

  proposeContractChange(
    symbolId: string,
    newSignature: string,
    agentId: string,
    reason: string,
  ): ChangeProposal {
    const contract = this.contracts.get(symbolId);
    const oldSignature = contract?.signature ?? "";

    // Compute impacted symbols using the graph's dependency index
    const impactedSymbols = this.graphStore.getDependents(symbolId);

    const id = `proposal-${crypto.randomUUID()}`;
    const proposal: ChangeProposal = {
      id,
      symbolId,
      agentId,
      oldSignature,
      newSignature,
      reason,
      impactedSymbols,
      status: "pending",
    };

    this.proposals.set(id, proposal);
    return proposal;
  }

  approveProposal(proposalId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return;
    proposal.status = "approved";

    // Update the contract's signature
    const contract = this.contracts.get(proposal.symbolId);
    if (contract) {
      contract.signature = proposal.newSignature;
    }
  }

  rejectProposal(proposalId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return;
    proposal.status = "rejected";
  }

  getPendingProposals(): ChangeProposal[] {
    return [...this.proposals.values()].filter((p) => p.status === "pending");
  }
}
