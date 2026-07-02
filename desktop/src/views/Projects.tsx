import { Snapshot } from "../protocol";
import { daemon } from "../daemon";

/**
 * Projects panel: the existing TUI's per-project server/port-forward controls,
 * re-rendered. Same daemon calls the TUI will issue once it becomes a client.
 */
export default function Projects({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.projects.length === 0) {
    return (
      <p className="empty big">
        No projects registered. Run <code>wf add &lt;path&gt;</code> — the board updates live.
      </p>
    );
  }

  return (
    <div className="projects-view">
      {snapshot.projects.map((project) => {
        const services = snapshot.services.filter((s) => s.project === project.name);
        const pfs = snapshot.portforwards.filter((pf) => pf.project === project.name);
        return (
          <section key={project.name} className="project">
            <header>
              <h2>{project.name}</h2>
              <span className="meta">
                {project.path} · ports {project.portRange[0]}–{project.portRange[1]}
              </span>
              <span className="actions">
                <button
                  onClick={() =>
                    void daemon.request("service.startAll", { project: project.name })
                  }
                >
                  start all
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    void daemon.request("service.stopAll", { project: project.name })
                  }
                >
                  stop all
                </button>
              </span>
            </header>

            <table>
              <tbody>
                {project.declaredServices.map((name) => {
                  const svc = services.find((s) => s.name === name);
                  return (
                    <tr key={name}>
                      <td className="name">{name}</td>
                      <td>
                        <span className={`status status-${svc?.status ?? "stopped"}`}>
                          {svc?.status ?? "stopped"}
                        </span>
                      </td>
                      <td className="port">
                        {svc && svc.allocatedPort > 0 ? `:${svc.allocatedPort}` : ""}
                      </td>
                      <td className="cmd">{svc?.command ?? ""}</td>
                      <td className="actions">
                        <button
                          onClick={() =>
                            void daemon.request("service.restart", {
                              project: project.name,
                              service: name,
                            })
                          }
                        >
                          restart
                        </button>
                        <button
                          className="danger"
                          onClick={() =>
                            void daemon.request("service.stop", {
                              project: project.name,
                              service: name,
                            })
                          }
                        >
                          stop
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {pfs.map((pf) => (
                  <tr key={`pf-${pf.name}`}>
                    <td className="name">⇄ {pf.name}</td>
                    <td>
                      <span className={`status status-${pf.status}`}>{pf.status}</span>
                    </td>
                    <td className="port">
                      :{pf.localPort} → {pf.remotePort}
                    </td>
                    <td className="cmd">
                      {pf.namespace}/{pf.pod}
                    </td>
                    <td className="actions">
                      <button
                        className="danger"
                        onClick={() =>
                          void daemon.request("portforward.stop", {
                            project: project.name,
                            name: pf.name,
                          })
                        }
                      >
                        stop
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
