import { Bus } from '../shared/bus';

let bus: Bus | null = null;
/** Bus-Instanz der API (RPC-Aufrufe an den Bot, Live-Events, Config-Sync). */
export function apiBus(): Bus {
  if (!bus) bus = new Bus('api');
  return bus;
}
