// Native quick picks for model, agent and session, populated from the server.
import * as vscode from 'vscode';
import type { Controller } from './controller';

export async function pickModel(ctl: Controller): Promise<void> {
  const models = await ctl.listModels();
  const pick = await vscode.window.showQuickPick(
    models.map((m) => ({ label: m.name, description: `${m.providerID}/${m.id}`, picked: m.name === ctl.state.model, model: m })),
    { placeHolder: `Model (current: ${ctl.state.model ?? 'default'})`, matchOnDescription: true },
  );
  if (pick) await ctl.setModel(pick.model);
}

export async function pickAgent(ctl: Controller): Promise<void> {
  const agents = await ctl.listAgents();
  const pick = await vscode.window.showQuickPick(
    agents.map((a) => ({ label: a.name, description: a.description, agent: a })),
    { placeHolder: `Agent (current: ${ctl.state.agent ?? 'default'})` },
  );
  if (pick) await ctl.setAgent(pick.agent);
}

export async function pickSession(ctl: Controller): Promise<void> {
  const sessions = await ctl.listSessions();
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(add) New session', id: undefined },
      ...sessions.map((s) => ({
        label: s.title || s.id,
        description: new Date(s.time.updated).toLocaleString(),
        id: s.id,
      })),
    ],
    { placeHolder: 'Resume a session in this workspace' },
  );
  if (!pick) return;
  if (pick.id) await ctl.resume(pick.id);
  else ctl.newSession();
}
