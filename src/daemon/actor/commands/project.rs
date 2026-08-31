use crate::service::kill_listeners_on_ports;

use crate::daemon::actor::{Command, Daemon};

impl Daemon {
    pub(crate) async fn handle_project_command(&mut self, cmd: Command) {
        match cmd {
            Command::AddProject {
                path,
                name,
                port_range,
                reply,
            } => {
                let result = self.add_project(&path, name.as_deref(), port_range).await;
                let _ = reply.send(result);
            }
            Command::RemoveProject {
                name,
                stop_resources,
                reply,
            } => {
                let result = self.remove_project(&name, stop_resources).await;
                let _ = reply.send(result);
            }
            Command::SetPortRange {
                project,
                range,
                reply,
            } => {
                let result = self.set_port_range_override(&project, range);
                let _ = reply.send(result);
            }

            Command::OpenProject { name } => self.open_project(&name).await,
            Command::StartService { project, service } => {
                self.start_one_service(&project, &service).await;
            }
            Command::StopService { project, service } => {
                self.services.stop(&project, &service).await.ok();
                self.emit_service_status(&project, &service);
            }
            Command::RestartService { project, service } => {
                self.services.stop(&project, &service).await.ok();
                self.emit_service_status(&project, &service);
                self.start_one_service(&project, &service).await;
            }
            Command::StartAllServices { project } => {
                self.start_services(&project).await;
            }
            Command::StopProject { project } => {
                let services: Vec<String> = self
                    .services
                    .list_for_project(&project)
                    .into_iter()
                    .map(|svc| svc.name.clone())
                    .collect();
                let pfs: Vec<String> = self
                    .portforwards
                    .list_for_project(&project)
                    .iter()
                    .map(|pf| pf.name.clone())
                    .collect();
                self.services.stop_project(&project).await.ok();
                self.portforwards.stop_project(&project);
                // Only ports this daemon handed out — a declared range can
                // hold processes warpforge never started (ADR 0006 invariant 3).
                if let Some(range) = self.port_range_for(&project) {
                    kill_listeners_on_ports(&crate::ports::allocated_in_ranges(&[range])).await;
                }
                for service in services {
                    self.emit_service_status(&project, &service);
                }
                self.emit_portforward_statuses(&project, &pfs);
            }
            Command::StopRuntime => {
                self.stop_runtime().await;
            }
            Command::ServiceLogs {
                project,
                service,
                after,
                limit,
                reply,
            } => {
                let (lines, at, next_seq) =
                    self.services.log_window(&project, &service, after, limit);
                let _ = reply.send((lines, at, next_seq));
            }
            Command::StartAllPortForwards { project } => {
                self.start_portforwards(&project).await;
            }
            Command::StartPortForward { project, name } => {
                self.start_one_portforward(&project, &name).await;
            }
            Command::StopPortForward { project, name } => {
                self.portforwards.stop(&project, &name);
                self.emit_portforward_status(&project, &name);
            }
            Command::StopAllPortForwards { project } => {
                let pfs: Vec<String> = self
                    .portforwards
                    .list_for_project(&project)
                    .iter()
                    .map(|pf| pf.name.clone())
                    .collect();
                self.portforwards.stop_project(&project);
                for name in pfs {
                    self.emit_portforward_status(&project, &name);
                }
            }
            Command::PortForwardLogs {
                project,
                name,
                after,
                limit,
                reply,
            } => {
                let (lines, at, next_seq) =
                    self.portforwards.log_window(&project, &name, after, limit);
                let _ = reply.send((lines, at, next_seq));
            }

            other => self.handle_agent_command(other).await,
        }
    }
}
