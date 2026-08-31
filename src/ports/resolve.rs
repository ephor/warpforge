//! Pure port-range resolution: explicit ranges win, sticky ranges are kept
//! when free, everything else gets the first free aligned block above 4000.

const DEFAULT_RANGE_SIZE: u16 = 100;
const SCAN_BASE: u32 = 4000;

pub struct ProjectPortInput {
    pub name: String,
    /// From the project's committed config `ports.range`, already parsed.
    pub declared: Option<(u16, u16)>,
    /// From the registry: sticky auto-assigned range.
    pub sticky: Option<(u16, u16)>,
    /// From the registry: local override; beats `declared`.
    pub local_override: Option<(u16, u16)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSource {
    LocalOverride,
    Declared,
    Sticky,
    Assigned,
}

#[derive(Debug, Clone)]
pub struct ResolvedRange {
    pub name: String,
    pub range: (u16, u16),
    pub source: RangeSource,
    /// Set when another project declared an overlapping explicit range.
    pub conflict_with: Option<String>,
}

fn overlaps(a: (u16, u16), b: (u16, u16)) -> bool {
    a.0 <= b.1 && b.0 <= a.1
}

/// A range already placed, with the name of the project that owns it.
struct Placed {
    range: (u16, u16),
    owner: String,
}

/// Resolve one range per project, in input order.
///
/// 1. Explicit ranges (override beats declared) are placed first, in input
///    order, and never relocated.
/// 2. Explicit overlaps: the later project keeps its range but records
///    `conflict_with` pointing at the earlier one.
/// 3. Every sticky range that clears the explicit ones is reserved next —
///    reserving all of them before anything is assigned keeps one relocation
///    from cascading onto another project's uncontested sticky range.
/// 4. Remaining projects get the first free `size`-aligned block scanned
///    upward from 4000 (`source: Assigned`).
pub fn resolve_ranges(projects: &[ProjectPortInput]) -> Vec<ResolvedRange> {
    let mut results: Vec<Option<ResolvedRange>> = vec![None; projects.len()];
    let mut placed: Vec<Placed> = Vec::new();

    // Pass 1: explicit ranges, in input order.
    for (i, project) in projects.iter().enumerate() {
        let explicit = project.local_override.or(project.declared);
        let Some(range) = explicit else { continue };
        let conflict_with = placed
            .iter()
            .find(|p| overlaps(p.range, range))
            .map(|p| p.owner.clone());
        placed.push(Placed {
            range,
            owner: project.name.clone(),
        });
        let source = if project.local_override.is_some() {
            RangeSource::LocalOverride
        } else {
            RangeSource::Declared
        };
        results[i] = Some(ResolvedRange {
            name: project.name.clone(),
            range,
            source,
            conflict_with,
        });
    }

    // Pass 2a: reserve every sticky range that clears the explicit ranges
    // before anything is assigned. Doing all reservations first means one
    // relocation cannot cascade onto another project's uncontested sticky
    // range — a project keeps its sticky range unless the range itself
    // collides with an explicit one.
    for (i, project) in projects.iter().enumerate() {
        if results[i].is_some() {
            continue;
        }
        let Some(sticky) = project.sticky else {
            continue;
        };
        if placed.iter().any(|p| overlaps(p.range, sticky)) {
            continue;
        }
        placed.push(Placed {
            range: sticky,
            owner: project.name.clone(),
        });
        results[i] = Some(ResolvedRange {
            name: project.name.clone(),
            range: sticky,
            source: RangeSource::Sticky,
            conflict_with: None,
        });
    }

    // Pass 2b: everything still unresolved gets the first free block scanned
    // around all reservations.
    for (i, project) in projects.iter().enumerate() {
        if results[i].is_some() {
            continue;
        }
        let size = project
            .sticky
            .map(|(start, end)| end.saturating_sub(start).saturating_add(1))
            .unwrap_or(DEFAULT_RANGE_SIZE)
            .max(1);
        let (range, conflict_with) = match first_free_block(&placed, size) {
            Some(range) => (range, None),
            None => {
                // Registry exhausted — clamp to the last possible block. That
                // block necessarily overlaps what is already placed; surface
                // the owner instead of pretending the range is clean.
                let clamp = (u16::MAX - size + 1, u16::MAX);
                let conflict_with = placed
                    .iter()
                    .rfind(|p| overlaps(p.range, clamp))
                    .map(|p| p.owner.clone());
                (clamp, conflict_with)
            }
        };
        placed.push(Placed {
            range,
            owner: project.name.clone(),
        });
        results[i] = Some(ResolvedRange {
            name: project.name.clone(),
            range,
            source: RangeSource::Assigned,
            conflict_with,
        });
    }

    results.into_iter().flatten().collect()
}

/// First `size`-aligned block at or above 4000 that overlaps nothing placed,
/// or `None` when no block fits above the base.
fn first_free_block(placed: &[Placed], size: u16) -> Option<(u16, u16)> {
    let size = size.max(1) as u32;
    let mut candidate = SCAN_BASE;
    loop {
        let end = candidate + size - 1;
        if end > u16::MAX as u32 {
            return None;
        }
        let block = (candidate as u16, end as u16);
        if !placed.iter().any(|p| overlaps(p.range, block)) {
            return Some(block);
        }
        candidate += size;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        name: &str,
        declared: Option<(u16, u16)>,
        sticky: Option<(u16, u16)>,
    ) -> ProjectPortInput {
        ProjectPortInput {
            name: name.to_string(),
            declared,
            sticky,
            local_override: None,
        }
    }

    #[test]
    fn override_beats_declared() {
        let projects = vec![ProjectPortInput {
            name: "a".into(),
            declared: Some((4200, 4299)),
            sticky: None,
            local_override: Some((5000, 5099)),
        }];
        let out = resolve_ranges(&projects);
        assert_eq!(out[0].range, (5000, 5099));
        assert_eq!(out[0].source, RangeSource::LocalOverride);
        assert_eq!(out[0].conflict_with, None);
    }

    #[test]
    fn identical_declared_ranges_conflict_on_second_only() {
        let projects = vec![
            input("a", Some((4200, 4299)), None),
            input("b", Some((4200, 4299)), None),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[0].conflict_with, None);
        assert_eq!(out[1].conflict_with.as_deref(), Some("a"));
        assert_eq!(out[1].range, (4200, 4299));
    }

    #[test]
    fn sticky_colliding_with_declared_gets_relocated() {
        let projects = vec![
            input("sticky", None, Some((4200, 4299))),
            input("declared", Some((4200, 4299)), None),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[1].range, (4200, 4299));
        assert_eq!(out[1].source, RangeSource::Declared);
        assert_eq!(out[0].range, (4000, 4099));
        assert_eq!(out[0].source, RangeSource::Assigned);
    }

    #[test]
    fn nothing_set_gets_4000_when_free() {
        let out = resolve_ranges(&[input("a", None, None)]);
        assert_eq!(out[0].range, (4000, 4099));
        assert_eq!(out[0].source, RangeSource::Assigned);
    }

    #[test]
    fn nothing_set_gets_4100_when_4000_taken() {
        let projects = vec![input("a", Some((4000, 4099)), None), input("b", None, None)];
        let out = resolve_ranges(&projects);
        assert_eq!(out[1].range, (4100, 4199));
    }

    #[test]
    fn sticky_kept_when_free() {
        let projects = vec![
            input("a", Some((4000, 4099)), None),
            input("b", None, Some((4100, 4199))),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[1].range, (4100, 4199));
        assert_eq!(out[1].source, RangeSource::Sticky);
    }

    #[test]
    fn non_default_size_scan() {
        let projects = vec![
            input("a", Some((4000, 4049)), None),
            input("b", None, Some((4000, 4049))),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[1].range, (4050, 4099));
        assert_eq!(out[1].source, RangeSource::Assigned);
    }

    #[test]
    fn assigned_scans_in_size_aligned_steps() {
        let projects = vec![
            input("a", Some((4000, 4099)), None),
            input("b", None, Some((4200, 4299))),
            input("c", None, None),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[2].range, (4100, 4199));
    }

    #[test]
    fn output_preserves_input_order() {
        let projects = vec![
            input("x", None, None),
            input("y", Some((4000, 4099)), None),
            input("z", None, None),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[0].name, "x");
        assert_eq!(out[1].name, "y");
        assert_eq!(out[2].name, "z");
        assert_eq!(out[0].range, (4100, 4199));
        assert_eq!(out[2].range, (4200, 4299));
    }

    #[test]
    fn conflict_detected_with_leading_implicit_project() {
        let projects = vec![
            input("imp", None, None),
            input("a", Some((4200, 4299)), None),
            input("b", Some((4200, 4299)), None),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[0].range, (4000, 4099));
        assert_eq!(out[1].conflict_with, None);
        assert_eq!(out[2].conflict_with.as_deref(), Some("a"));
    }

    #[test]
    fn conflict_reports_earlier_project_name() {
        let projects = vec![
            input("imp1", None, None),
            input("a", Some((4200, 4299)), None),
            input("imp2", None, None),
            input("b", Some((4200, 4299)), None),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[2].range, (4100, 4199));
        assert_eq!(out[3].conflict_with.as_deref(), Some("a"));
    }

    /// Declaring one explicit range must relocate only the project that
    /// actually collides with it. A later sticky range that touches nothing
    /// explicit keeps its ports — a relocation must not cascade onto it.
    #[test]
    fn declared_range_does_not_cascade_onto_uncontested_sticky() {
        let projects = vec![
            input("p1", None, Some((4000, 4099))),
            input("p2", None, Some((4100, 4199))),
            input("d", Some((4000, 4099)), None),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[2].range, (4000, 4099));
        assert_eq!(out[2].source, RangeSource::Declared);
        assert_eq!(
            out[1].range,
            (4100, 4199),
            "p2's sticky range is uncontested and must be kept"
        );
        assert_eq!(out[1].source, RangeSource::Sticky);
        assert_eq!(
            out[0].range,
            (4200, 4299),
            "only p1, which actually collides, relocates"
        );
        assert_eq!(out[0].source, RangeSource::Assigned);
    }

    /// When the whole port space is taken, the clamp overlap is not silent:
    /// it records who it overlaps.
    #[test]
    fn exhausted_registry_clamps_with_a_conflict_owner() {
        let projects = vec![
            input("hog", Some((1024, 65535)), None),
            input("late", None, None),
        ];
        let out = resolve_ranges(&projects);
        assert_eq!(out[1].range, (u16::MAX - 99, u16::MAX));
        assert_eq!(out[1].source, RangeSource::Assigned);
        assert_eq!(
            out[1].conflict_with.as_deref(),
            Some("hog"),
            "the clamp must not pretend it is conflict-free"
        );
    }
}
