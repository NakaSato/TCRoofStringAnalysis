//! Visit order for one day of site visits. Port of `backend/solar_core/visit_route.py`.
//!
//! The matrix holds drive minutes between points: index 0 is the start point, 1..n are the
//! stops, and it may be asymmetric. Times are minutes after local midnight. A stop reached
//! before its window opens waits; one reached after it closes is still visited and counts as
//! late. Orders are ranked by total lateness, then finish time, then total driving.
//!
//! Up to [`MAX_EXACT`] stops the search is exact (Held–Karp with Pareto labels), up to
//! [`MAX_STOPS`] it is a seeded local search (nearest neighbour starts, 2-opt, Or-opt). Every
//! rule, tie-break, constant and the seeded random stream are Python's, so the chosen order is
//! the same as Python's for the same input.

use crate::py_random::PyRandom;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;

/// Exact search up to this many stops.
pub const MAX_EXACT: usize = 10;
/// Heuristic up to this many; more is [`RouteError::TooManyStops`].
pub const MAX_STOPS: usize = 25;

const EPS: f64 = 1e-9; // float noise allowed when comparing objectives
const SEED: u32 = 7; // fixed: the heuristic gives the same order for the same input
const RANDOM_STARTS: usize = 12; // randomised nearest-neighbour starts besides the plain ones
const RANDOM_PICK: usize = 3; // a randomised start picks among this many nearest stops

/// (late, finish, drive), Python's `_Cost`.
pub type Cost = (f64, f64, f64);

/// Python's `EndMode` ("return" | "last").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EndMode {
    /// Drive back to the start after the last stop.
    Return,
    /// End at the last stop's departure.
    Last,
}

impl EndMode {
    /// Python's check in `_Problem.__init__`: "return" or "last", anything else a ValueError.
    pub fn parse(s: &str) -> Result<Self, RouteError> {
        match s {
            "return" => Ok(EndMode::Return),
            "last" => Ok(EndMode::Last),
            _ => Err(RouteError::Invalid(format!(
                "end_mode must be 'return' or 'last', not '{s}'"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            EndMode::Return => "return",
            EndMode::Last => "last",
        }
    }
}

/// Python's `Method`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Exact,
    Heuristic,
    Fixed,
    Trivial,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Exact => "exact",
            Method::Heuristic => "heuristic",
            Method::Fixed => "fixed",
            Method::Trivial => "trivial",
        }
    }
}

/// Python's `ValueError` / `TooManyStops(ValueError)` of the solver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    /// Bad input (Python `ValueError`).
    Invalid(String),
    /// More stops than one route plans (Python `TooManyStops`, a `ValueError` subclass).
    TooManyStops(String),
}

impl fmt::Display for RouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RouteError::Invalid(m) | RouteError::TooManyStops(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for RouteError {}

/// Python's `StopSpec`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StopSpec {
    /// Time on site.
    pub service_min: f64,
    /// Allowed arrival, minutes after local midnight (open, close).
    pub window: Option<(f64, f64)>,
}

impl StopSpec {
    pub fn new(service_min: f64) -> Self {
        StopSpec {
            service_min,
            window: None,
        }
    }

    pub fn with_window(service_min: f64, open: f64, close: f64) -> Self {
        StopSpec {
            service_min,
            window: Some((open, close)),
        }
    }
}

/// Python's `StopTimes`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StopTimes {
    /// Matrix index of this stop (1..n).
    pub index: usize,
    /// Drive from the previous point (start or previous stop).
    pub leg_drive_min: f64,
    /// Minutes after local midnight.
    pub arrive_min: f64,
    /// Waiting for the window to open (0 if none).
    pub wait_min: f64,
    /// arrive + wait + service.
    pub depart_min: f64,
    /// Arrival after window close (0 when on time / no window).
    pub late_min: f64,
}

/// Python's `Solution`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Solution {
    /// Matrix indices of the stops in visit order (a permutation of 1..n).
    pub order: Vec<usize>,
    /// Same order.
    pub stops: Vec<StopTimes>,
    /// Last stop → start when end_mode is "return", else None.
    pub end_leg_drive_min: Option<f64>,
    /// Back at start (return), else None.
    pub end_arrive_min: Option<f64>,
    /// end_arrive_min (return) or last depart_min (last); leave_min when no stops.
    pub finish_min: f64,
    /// Total driving, incl. the return leg.
    pub drive_min: f64,
    pub wait_min: f64,
    /// Sum of late_min.
    pub late_min: f64,
    pub method: Method,
}

/// Python's `repr(float)` closely enough for error messages.
fn py_float(x: f64) -> String {
    if x.is_nan() {
        "nan".into()
    } else if x.is_infinite() {
        if x > 0.0 {
            "inf".into()
        } else {
            "-inf".into()
        }
    } else if x.fract() == 0.0 && x.abs() < 1e16 {
        format!("{x:.1}")
    } else {
        format!("{x:?}")
    }
}

/// Python's `_num`: a finite number, else a ValueError naming `what`.
fn num(value: Option<f64>, what: &str) -> Result<f64, RouteError> {
    let x = value.ok_or_else(|| RouteError::Invalid(format!("{what} is missing")))?;
    if !x.is_finite() {
        return Err(RouteError::Invalid(format!(
            "{what} is not finite: {}",
            py_float(x)
        )));
    }
    Ok(x)
}

type State = (usize, f64, f64, f64); // (node, depart time, late so far, drive so far)

/// Python's `_Problem`: validated input; node 0 = start, nodes 1..n = stops.
struct Problem {
    n: usize,
    d: Vec<Vec<f64>>,
    svc: Vec<f64>,
    wo: Vec<f64>,
    wc: Vec<f64>,
    leave: f64,
    ret: bool,
    has_windows: bool,
}

impl Problem {
    fn new<R, V>(
        duration_min: &[R],
        stops: &[StopSpec],
        leave_min: f64,
        end_mode: EndMode,
    ) -> Result<Self, RouteError>
    where
        R: AsRef<[V]>,
        V: Copy + Into<Option<f64>>,
    {
        let n = stops.len();
        if duration_min.len() != n + 1 {
            return Err(RouteError::Invalid(format!(
                "duration matrix has {} rows, expected {} (start + {n} stops)",
                duration_min.len(),
                n + 1
            )));
        }
        let mut d = Vec::with_capacity(n + 1);
        for (i, row) in duration_min.iter().enumerate() {
            let row = row.as_ref();
            if row.len() != n + 1 {
                return Err(RouteError::Invalid(format!(
                    "duration matrix row {i} must have {} entries",
                    n + 1
                )));
            }
            let mut out = Vec::with_capacity(n + 1);
            for (j, v) in row.iter().enumerate() {
                let x = num((*v).into(), &format!("duration [{i}][{j}]"))?;
                if x < 0.0 {
                    return Err(RouteError::Invalid(format!(
                        "duration [{i}][{j}] is negative: {}",
                        py_float(x)
                    )));
                }
                out.push(x);
            }
            d.push(out);
        }
        let mut svc = vec![0.0; n + 1];
        let mut wo = vec![f64::NEG_INFINITY; n + 1];
        let mut wc = vec![f64::INFINITY; n + 1];
        for (idx, s) in stops.iter().enumerate() {
            let k = idx + 1;
            svc[k] = num(Some(s.service_min), &format!("stop {k} service_min"))?;
            if svc[k] < 0.0 {
                return Err(RouteError::Invalid(format!(
                    "stop {k} service_min is negative: {}",
                    py_float(svc[k])
                )));
            }
            if let Some((open, close)) = s.window {
                let lo = num(Some(open), &format!("stop {k} window open"))?;
                let hi = num(Some(close), &format!("stop {k} window close"))?;
                if lo > hi {
                    return Err(RouteError::Invalid(format!(
                        "stop {k} window opens after it closes: ({}, {})",
                        py_float(lo),
                        py_float(hi)
                    )));
                }
                wo[k] = lo;
                wc[k] = hi;
            }
        }
        let leave = num(Some(leave_min), "leave_min")?;
        Ok(Problem {
            n,
            d,
            svc,
            wo,
            wc,
            leave,
            ret: end_mode == EndMode::Return,
            has_windows: stops.iter().any(|s| s.window.is_some()),
        })
    }

    fn start_state(&self) -> State {
        (0, self.leave, 0.0, 0.0)
    }

    /// State after each stop: prefix[k] = after the first k stops of `order`.
    fn prefix(&self, order: &[usize]) -> Vec<State> {
        let (mut node, mut t, mut late, mut drive) = self.start_state();
        let mut out = Vec::with_capacity(order.len() + 1);
        out.push((node, t, late, drive));
        for &j in order {
            let leg = self.d[node][j];
            let arr = t + leg;
            drive += leg;
            if arr > self.wc[j] {
                late += arr - self.wc[j];
            }
            t = py_max(arr, self.wo[j]) + self.svc[j];
            node = j;
            out.push((node, t, late, drive));
        }
        out
    }

    /// (late, finish, drive) of visiting `seq` from `state`, then the end leg. With `bound` =
    /// (late, finish) of a known route, None as soon as this one is certainly worse.
    fn tail(&self, state: State, seq: &[usize], bound: Option<(f64, f64)>) -> Option<Cost> {
        let (mut node, mut t, mut late, mut drive) = state;
        for &j in seq {
            let leg = self.d[node][j];
            let arr = t + leg;
            drive += leg;
            if arr > self.wc[j] {
                late += arr - self.wc[j];
            }
            t = py_max(arr, self.wo[j]) + self.svc[j];
            node = j;
            if let Some((bl, bt)) = bound {
                if late > bl + EPS || (late >= bl - EPS && t > bt + EPS) {
                    return None;
                }
            }
        }
        if self.ret {
            let leg = self.d[node][0];
            drive += leg;
            t += leg;
        }
        Some((late, t, drive))
    }

    fn cost(&self, order: &[usize]) -> Cost {
        self.tail(self.start_state(), order, None)
            .expect("no bound, always a cost")
    }
}

/// Python's builtin `max(a, b)`: `a` unless `b > a`.
#[inline]
fn py_max(a: f64, b: f64) -> f64 {
    if b > a {
        b
    } else {
        a
    }
}

/// Python's `_better`: a strictly better than b (less late, then earlier finish, then less driving).
fn better(a: Cost, b: Cost) -> bool {
    for (x, y) in [(a.0, b.0), (a.1, b.1), (a.2, b.2)] {
        if x < y - EPS {
            return true;
        }
        if x > y + EPS {
            return false;
        }
    }
    false
}

/// Python's `_times`.
fn times(p: &Problem, order: &[usize], method: Method) -> Solution {
    let (d, svc, wo, wc) = (&p.d, &p.svc, &p.wo, &p.wc);
    let mut node = 0usize;
    let mut t = p.leave;
    let (mut drive, mut wait_tot, mut late_tot) = (0.0, 0.0, 0.0);
    let mut stops = Vec::with_capacity(order.len());
    for &j in order {
        let leg = d[node][j];
        let arr = t + leg;
        let wait = if arr < wo[j] { wo[j] - arr } else { 0.0 };
        let late = if arr > wc[j] { arr - wc[j] } else { 0.0 };
        t = arr + wait + svc[j];
        stops.push(StopTimes {
            index: j,
            leg_drive_min: leg,
            arrive_min: arr,
            wait_min: wait,
            depart_min: t,
            late_min: late,
        });
        drive += leg;
        wait_tot += wait;
        late_tot += late;
        node = j;
    }
    let (mut end_leg, mut end_arrive) = (None, None);
    if p.ret {
        let leg = if order.is_empty() { 0.0 } else { d[node][0] };
        let arrive = t + leg;
        drive += leg;
        t = arrive;
        end_leg = Some(leg);
        end_arrive = Some(arrive);
    }
    Solution {
        order: order.to_vec(),
        stops,
        end_leg_drive_min: end_leg,
        end_arrive_min: end_arrive,
        finish_min: t,
        drive_min: drive,
        wait_min: wait_tot,
        late_min: late_tot,
        method,
    }
}

/// Python's `_check_order`.
fn check_order(p: &Problem, order: &[usize]) -> Result<Vec<usize>, RouteError> {
    let mut sorted = order.to_vec();
    sorted.sort_unstable();
    if sorted != (1..=p.n).collect::<Vec<_>>() {
        return Err(RouteError::Invalid(format!(
            "order must be a permutation of 1..{}, got {order:?}",
            p.n
        )));
    }
    Ok(order.to_vec())
}

// --- exact: Held–Karp over (visited set, last stop) with Pareto labels ----------------------
//
// A label is (late, depart time, drive, node, parent label). Labels live in an arena and the
// per-state lists hold arena indices, in the same order as Python's lists (that order decides
// ties in the final pick).

#[derive(Clone, Copy)]
struct Label {
    late: f64,
    t: f64,
    drive: f64,
    node: usize,
    parent: Option<usize>,
}

/// Python's `_insert`: add `new` unless a label of the list is no worse in all three; drop the
/// labels `new` is no worse than.
fn insert(arena: &mut Vec<Label>, labels: &mut Vec<usize>, new: Label) {
    for &o in labels.iter() {
        let o = &arena[o];
        if o.late <= new.late && o.t <= new.t && o.drive <= new.drive {
            return;
        }
    }
    labels.retain(|&o| {
        let o = &arena[o];
        !(new.late <= o.late && new.t <= o.t && new.drive <= o.drive)
    });
    arena.push(new);
    labels.push(arena.len() - 1);
}

/// Python's `_exact`.
fn exact(p: &Problem) -> Vec<usize> {
    let n = p.n;
    let full = (1usize << n) - 1;
    let mut table: Vec<Option<Vec<Vec<usize>>>> = vec![None; full + 1];
    let mut arena: Vec<Label> = Vec::new();

    let extend = |lab: &Label, lab_idx: Option<usize>, j: usize| -> Label {
        let mut late = lab.late;
        let leg = p.d[lab.node][j];
        let arr = lab.t + leg;
        if arr > p.wc[j] {
            late += arr - p.wc[j];
        }
        Label {
            late,
            t: py_max(arr, p.wo[j]) + p.svc[j],
            drive: lab.drive + leg,
            node: j,
            parent: lab_idx,
        }
    };

    let root = Label {
        late: 0.0,
        t: p.leave,
        drive: 0.0,
        node: 0,
        parent: None,
    };
    for k in 0..n {
        let mut row: Vec<Vec<usize>> = vec![Vec::new(); n];
        let lab = extend(&root, None, k + 1);
        arena.push(lab);
        row[k].push(arena.len() - 1);
        table[1 << k] = Some(row);
    }
    for mask in 1..full {
        let Some(row) = table[mask].take() else {
            continue;
        };
        for labels in row.iter() {
            for &li in labels {
                let lab = arena[li];
                for m in 0..n {
                    let bit = 1usize << m;
                    if mask & bit != 0 {
                        continue;
                    }
                    let new = extend(&lab, Some(li), m + 1);
                    let nxt = table[mask | bit].get_or_insert_with(|| vec![Vec::new(); n]);
                    insert(&mut arena, &mut nxt[m], new);
                }
            }
        }
        // Python sets table[mask] = None: every label still needed is reachable from its children
    }
    let mut best: Option<usize> = None;
    let mut best_cost: Option<Cost> = None;
    let last_row = table[full].as_ref().expect("full set reached");
    for (k, labels) in last_row.iter().enumerate() {
        for &li in labels {
            let lab = &arena[li];
            let back = if p.ret { p.d[k + 1][0] } else { 0.0 };
            let c = (lab.late, lab.t + back, lab.drive + back);
            if best_cost.is_none_or(|bc| better(c, bc)) {
                best = Some(li);
                best_cost = Some(c);
            }
        }
    }
    let mut order = Vec::with_capacity(n);
    while let Some(li) = best {
        let lab = &arena[li];
        if lab.node == 0 {
            break;
        }
        order.push(lab.node);
        best = lab.parent;
    }
    order.reverse();
    order
}

// --- heuristic: seeded starts + 2-opt / Or-opt on the real objective -------------------------

/// Python's `_nearest`: greedy by earliest possible start of service; with `rng`, a random
/// pick among the nearest few.
fn nearest(p: &Problem, mut rng: Option<&mut PyRandom>) -> Vec<usize> {
    let (d, wo) = (&p.d, &p.wo);
    let mut left: Vec<usize> = (1..=p.n).collect();
    let mut node = 0usize;
    let mut t = p.leave;
    let mut order = Vec::with_capacity(p.n);
    while !left.is_empty() {
        let mut ranked = left.clone();
        // key (max(t + d[node][j], wo[j]), j); no NaN after validation, so total
        ranked.sort_by(|&a, &b| {
            let ka = py_max(t + d[node][a], wo[a]);
            let kb = py_max(t + d[node][b], wo[b]);
            ka.partial_cmp(&kb).expect("finite keys").then(a.cmp(&b))
        });
        let j = match rng.as_deref_mut() {
            Some(r) => ranked[r.randrange(RANDOM_PICK.min(ranked.len()) as u32) as usize],
            None => ranked[0],
        };
        order.push(j);
        let pos = left.iter().position(|&x| x == j).expect("j is left");
        left.remove(pos);
        let arr = t + d[node][j];
        t = py_max(arr, wo[j]) + p.svc[j];
        node = j;
    }
    order
}

/// Python's `_improve`: first-improvement local search (Or-opt segments of 1–3, forward and
/// reversed, then 2-opt) until a full pass finds nothing better. The loop structure (which
/// candidates are tried after an improvement within the same pass) is Python's exactly.
fn improve(p: &Problem, order: &[usize]) -> (Vec<usize>, Cost) {
    let n = order.len();
    let mut cur = order.to_vec();
    let mut cost = p.cost(&cur);
    let mut pref = p.prefix(&cur);
    let mut improved = true;
    while improved {
        improved = false;
        for seg_len in 1..=3usize {
            if seg_len > n {
                continue; // Python: range(n - seg_len + 1) is empty
            }
            for i in 0..(n - seg_len + 1) {
                let mut seg: Vec<usize> = cur[i..i + seg_len].to_vec();
                let mut rest: Vec<usize> = [&cur[..i], &cur[i + seg_len..]].concat();
                let rest_len = rest.len();
                for k in 0..(rest_len + 1) {
                    let pieces: Vec<Vec<usize>> = if seg_len > 1 {
                        let mut rev = seg.clone();
                        rev.reverse();
                        vec![seg.clone(), rev]
                    } else {
                        vec![seg.clone()]
                    };
                    for (pi, piece) in pieces.iter().enumerate() {
                        if k == i && pi == 0 {
                            continue; // Python: `piece is seg`
                        }
                        let mut cand = Vec::with_capacity(n);
                        cand.extend_from_slice(&rest[..k]);
                        cand.extend_from_slice(piece);
                        cand.extend_from_slice(&rest[k..]);
                        let s = i.min(k);
                        let c = p.tail(pref[s], &cand[s..], Some((cost.0, cost.1)));
                        if let Some(c) = c {
                            if better(c, cost) {
                                cur = cand;
                                cost = c;
                                pref = p.prefix(&cur);
                                seg = cur[i..i + seg_len].to_vec();
                                rest = [&cur[..i], &cur[i + seg_len..]].concat();
                                improved = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
        for i in 0..n.saturating_sub(1) {
            for j in (i + 1)..n {
                let mut cand = cur.clone();
                cand[i..=j].reverse();
                let c = p.tail(pref[i], &cand[i..], Some((cost.0, cost.1)));
                if let Some(c) = c {
                    if better(c, cost) {
                        cur = cand;
                        cost = c;
                        pref = p.prefix(&cur);
                        improved = true;
                    }
                }
            }
        }
    }
    (cur, cost)
}

/// Python's `_heuristic`.
fn heuristic(p: &Problem) -> Vec<usize> {
    let mut rng = PyRandom::new(SEED);
    let mut starts: Vec<Vec<usize>> = vec![nearest(p, None), (1..=p.n).collect()];
    if p.has_windows {
        let mut by_window: Vec<usize> = (1..=p.n).collect();
        by_window.sort_by(|&a, &b| {
            p.wc[a]
                .partial_cmp(&p.wc[b])
                .expect("no NaN")
                .then(p.wo[a].partial_cmp(&p.wo[b]).expect("no NaN"))
                .then(a.cmp(&b))
        });
        starts.push(by_window);
    }
    for _ in 0..RANDOM_STARTS {
        starts.push(nearest(p, Some(&mut rng)));
    }
    let mut seen: HashSet<Vec<usize>> = HashSet::new();
    let mut best: Option<Vec<usize>> = None;
    let mut best_cost: Option<Cost> = None;
    for s in starts {
        if !seen.insert(s.clone()) {
            continue;
        }
        let (o, c) = improve(p, &s);
        if best_cost.is_none_or(|bc| better(c, bc)) {
            best = Some(o);
            best_cost = Some(c);
        }
    }
    best.expect("at least one start")
}

// --- public ---------------------------------------------------------------------------------

/// Port of `visit_route.evaluate`: times of visiting the stops in `order` (matrix indices
/// 1..n), leaving the start at `leave_min`.
///
/// Matrix entries may be `f64` or `Option<f64>` (`None` = an unroutable pair, a ValueError as
/// Python's `None`).
pub fn evaluate<R, V>(
    duration_min: &[R],
    stops: &[StopSpec],
    order: &[usize],
    leave_min: f64,
    end_mode: EndMode,
) -> Result<Solution, RouteError>
where
    R: AsRef<[V]>,
    V: Copy + Into<Option<f64>>,
{
    let p = Problem::new(duration_min, stops, leave_min, end_mode)?;
    let order = check_order(&p, order)?;
    Ok(times(&p, &order, Method::Fixed))
}

/// Port of `visit_route.solve`: best visit order, least total lateness, then earliest finish,
/// then least driving.
///
/// `end_mode` Return drives back to the start; Last ends at the last stop's departure.
/// `keep_order` only times the stops as given. More than [`MAX_STOPS`] is
/// [`RouteError::TooManyStops`].
pub fn solve<R, V>(
    duration_min: &[R],
    stops: &[StopSpec],
    leave_min: f64,
    end_mode: EndMode,
    keep_order: bool,
) -> Result<Solution, RouteError>
where
    R: AsRef<[V]>,
    V: Copy + Into<Option<f64>>,
{
    let p = Problem::new(duration_min, stops, leave_min, end_mode)?;
    let n = p.n;
    if n > MAX_STOPS {
        return Err(RouteError::TooManyStops(format!(
            "{n} stops is more than {MAX_STOPS} for one route; split the day into several routes"
        )));
    }
    let identity: Vec<usize> = (1..=n).collect();
    if keep_order {
        return Ok(times(&p, &identity, Method::Fixed));
    }
    if n <= 1 {
        return Ok(times(&p, &identity, Method::Trivial));
    }
    if n <= MAX_EXACT {
        return Ok(times(&p, &exact(&p), Method::Exact));
    }
    Ok(times(&p, &heuristic(&p), Method::Heuristic))
}

/// Internals exposed for the parity tests only (Python's `_nearest`, `_exact`, `_heuristic`).
#[doc(hidden)]
pub mod internals {
    use super::*;

    /// (`_nearest(p, None)`, `[_nearest(p, rng) for _ in range(_RANDOM_STARTS)]` with one
    /// `random.Random(_SEED)`, `_heuristic(p)`, `_exact(p)`).
    #[allow(clippy::type_complexity)]
    pub fn starts_and_orders(
        duration_min: &[Vec<f64>],
        stops: &[StopSpec],
        leave_min: f64,
        end_mode: EndMode,
    ) -> Result<(Vec<usize>, Vec<Vec<usize>>, Vec<usize>, Vec<usize>), RouteError> {
        let p = Problem::new(duration_min, stops, leave_min, end_mode)?;
        let mut rng = PyRandom::new(SEED);
        let randomised = (0..RANDOM_STARTS)
            .map(|_| nearest(&p, Some(&mut rng)))
            .collect();
        Ok((nearest(&p, None), randomised, heuristic(&p), exact(&p)))
    }

    /// `random.Random(seed).randrange(k)` for each k in turn, one generator.
    pub fn randrange_stream(seed: u32, ks: &[u32]) -> Vec<u32> {
        let mut r = PyRandom::new(seed);
        ks.iter().map(|&k| r.randrange(k)).collect()
    }

    /// Python's `_Problem(...).cost(order)`.
    pub fn cost(
        duration_min: &[Vec<f64>],
        stops: &[StopSpec],
        leave_min: f64,
        end_mode: EndMode,
        order: &[usize],
    ) -> Cost {
        Problem::new(duration_min, stops, leave_min, end_mode)
            .expect("valid")
            .cost(order)
    }

    /// Python's `_better`.
    pub fn is_better(a: Cost, b: Cost) -> bool {
        better(a, b)
    }

    /// Python's `_nearest(p, None)`.
    pub fn nearest_plain(
        duration_min: &[Vec<f64>],
        stops: &[StopSpec],
        leave_min: f64,
        end_mode: EndMode,
    ) -> Vec<usize> {
        nearest(
            &Problem::new(duration_min, stops, leave_min, end_mode).expect("valid"),
            None,
        )
    }

    /// Python's `_exact(p)` and `_heuristic(p)`.
    pub fn exact_and_heuristic(
        duration_min: &[Vec<f64>],
        stops: &[StopSpec],
        leave_min: f64,
        end_mode: EndMode,
    ) -> (Vec<usize>, Vec<usize>) {
        let p = Problem::new(duration_min, stops, leave_min, end_mode).expect("valid");
        (exact(&p), heuristic(&p))
    }
}
