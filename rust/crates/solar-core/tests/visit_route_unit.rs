//! Port of backend/tests/test_visit_route_solver.py. Random instances come from a small
//! deterministic generator (not Python's), and are checked against an independent brute force.

use std::time::Instant;
use tcroof_solar_core::visit_route::{
    evaluate, internals, solve, Cost, EndMode, Method, RouteError, Solution, StopSpec, MAX_EXACT,
    MAX_STOPS,
};

const R: EndMode = EndMode::Return;

/// splitmix64: a deterministic stand-in for Python's `random.Random(seed)` in the tests.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.next()
    }
    fn choice<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[((self.next() * xs.len() as f64) as usize).min(xs.len() - 1)]
    }
}

/// Points on a ~60 km square, asymmetric drive minutes, 20–90 min on site.
fn instance(rng: &mut Rng, n: usize, windows: bool) -> (Vec<Vec<f64>>, Vec<StopSpec>) {
    let pts: Vec<(f64, f64)> = (0..=n)
        .map(|_| (rng.uniform(0.0, 60.0), rng.uniform(0.0, 60.0)))
        .collect();
    let mut d = vec![vec![0.0; n + 1]; n + 1];
    for i in 0..=n {
        for j in 0..=n {
            if i != j {
                let dist = ((pts[i].0 - pts[j].0).powi(2) + (pts[i].1 - pts[j].1).powi(2)).sqrt();
                d[i][j] = dist * 1.4 * rng.uniform(1.0, 1.35) + 3.0;
            }
        }
    }
    let stops = (0..n)
        .map(|_| {
            let svc = rng.choice(&[20.0, 30.0, 45.0, 60.0, 90.0]);
            if windows && rng.next() < 0.6 {
                let lo = rng.uniform(480.0, 900.0);
                StopSpec::with_window(svc, lo, lo + rng.choice(&[30.0, 60.0, 120.0, 180.0]))
            } else {
                StopSpec::new(svc)
            }
        })
        .collect();
    (d, stops)
}

fn ref_cost(
    d: &[Vec<f64>],
    stops: &[StopSpec],
    order: &[usize],
    leave: f64,
    end_mode: EndMode,
) -> Cost {
    let (mut node, mut t, mut late, mut drive) = (0usize, leave, 0.0, 0.0);
    for &j in order {
        let s = stops[j - 1];
        let arr = t + d[node][j];
        drive += d[node][j];
        let mut start = arr;
        if let Some((lo, hi)) = s.window {
            start = arr.max(lo);
            late += (arr - hi).max(0.0);
        }
        t = start + s.service_min;
        node = j;
    }
    if end_mode == EndMode::Return {
        drive += d[node][0];
        t += d[node][0];
    }
    (late, t, drive)
}

fn permutations(items: &mut Vec<usize>, k: usize, out: &mut dyn FnMut(&[usize])) {
    if k == items.len() {
        out(items);
        return;
    }
    for i in k..items.len() {
        items.swap(k, i);
        permutations(items, k + 1, out);
        items.swap(k, i);
    }
}

fn brute(d: &[Vec<f64>], stops: &[StopSpec], leave: f64, end_mode: EndMode) -> Cost {
    let mut best: Option<Cost> = None;
    let mut items: Vec<usize> = (1..=stops.len()).collect();
    permutations(&mut items, 0, &mut |perm| {
        let c = ref_cost(d, stops, perm, leave, end_mode);
        if best.is_none_or(|b| internals::is_better(c, b)) {
            best = Some(c);
        }
    });
    best.unwrap()
}

fn obj(s: &Solution) -> Cost {
    (s.late_min, s.finish_min, s.drive_min)
}

fn approx(a: Cost, b: Cost) -> bool {
    (a.0 - b.0).abs() <= 1e-6 && (a.1 - b.1).abs() <= 1e-6 && (a.2 - b.2).abs() <= 1e-6
}

fn line(n: usize, gap: f64) -> Vec<Vec<f64>> {
    (0..=n)
        .map(|i| (0..=n).map(|j| (i as f64 - j as f64).abs() * gap).collect())
        .collect()
}

#[test]
fn exact_matches_brute_force() {
    for end_mode in [EndMode::Return, EndMode::Last] {
        for windows in [false, true] {
            let mut rng = Rng(1000 + windows as u64 * 7 + (end_mode == EndMode::Last) as u64);
            for n in 2..=8 {
                for _ in 0..(if n <= 6 { 6 } else { 3 }) {
                    let (d, stops) = instance(&mut rng, n, windows);
                    let sol = solve(&d, &stops, 480.0, end_mode, false).unwrap();
                    assert_eq!(sol.method, Method::Exact);
                    let mut sorted = sol.order.clone();
                    sorted.sort();
                    assert_eq!(sorted, (1..=n).collect::<Vec<_>>());
                    assert!(approx(obj(&sol), brute(&d, &stops, 480.0, end_mode)));
                    assert!(approx(
                        obj(&sol),
                        ref_cost(&d, &stops, &sol.order, 480.0, end_mode)
                    ));
                }
            }
        }
    }
}

#[test]
fn exact_tight_windows_force_lateness() {
    let mut rng = Rng(5);
    for _ in 0..5 {
        let (d, _) = instance(&mut rng, 6, false);
        let stops = vec![StopSpec::with_window(30.0, 470.0, 490.0); 6];
        let sol = solve(&d, &stops, 480.0, R, false).unwrap();
        assert!(sol.late_min > 0.0);
        assert!(approx(obj(&sol), brute(&d, &stops, 480.0, R)));
    }
}

#[test]
fn heuristic_within_5pct_of_exact() {
    for windows in [false, true] {
        let mut rng = Rng(42 + windows as u64);
        for _ in 0..8 {
            let (d, stops) = instance(&mut rng, 10, windows);
            let (ex, he) = internals::exact_and_heuristic(&d, &stops, 480.0, R);
            let ex = internals::cost(&d, &stops, 480.0, R, &ex);
            let he = internals::cost(&d, &stops, 480.0, R, &he);
            assert!(he.0 + he.1 - 480.0 <= 1.05 * (ex.0 + ex.1 - 480.0) + 1e-6);
        }
    }
}

#[test]
fn heuristic_25_stops_fast_and_deterministic() {
    let mut rng = Rng(9);
    for windows in [false, true] {
        let (d, stops) = instance(&mut rng, 25, windows);
        let t0 = Instant::now();
        let a = solve(&d, &stops, 480.0, R, false).unwrap();
        assert!(t0.elapsed().as_secs_f64() < 2.0);
        assert_eq!(a.method, Method::Heuristic);
        let mut sorted = a.order.clone();
        sorted.sort();
        assert_eq!(sorted, (1..=25).collect::<Vec<_>>());
        assert_eq!(a, solve(&d, &stops, 480.0, R, false).unwrap());
        let starts = [
            internals::nearest_plain(&d, &stops, 480.0, R),
            (1..=25).collect(),
        ];
        for s in starts {
            assert!(!internals::is_better(
                internals::cost(&d, &stops, 480.0, R, &s),
                obj(&a)
            ));
        }
    }
}

#[test]
fn exact_10_stops_fast_and_method_by_size() {
    let mut rng = Rng(3);
    for windows in [false, true] {
        let (d, stops) = instance(&mut rng, 10, windows);
        let t0 = Instant::now();
        let sol = solve(&d, &stops, 480.0, R, false).unwrap();
        assert!(t0.elapsed().as_secs_f64() < 1.0);
        assert_eq!(sol.method, Method::Exact);
    }
    let (d, stops) = instance(&mut rng, 11, false);
    assert_eq!(
        solve(&d, &stops, 480.0, R, false).unwrap().method,
        Method::Heuristic
    );
}

#[test]
fn wait_when_early_and_late_after_close() {
    let sol = evaluate(
        &line(1, 10.0),
        &[StopSpec::with_window(30.0, 540.0, 600.0)],
        &[1],
        480.0,
        R,
    )
    .unwrap();
    let s = sol.stops[0];
    assert_eq!(
        (s.arrive_min, s.wait_min, s.late_min, s.depart_min),
        (490.0, 50.0, 0.0, 570.0)
    );
    assert_eq!((sol.wait_min, sol.finish_min), (50.0, 580.0));
    let sol = evaluate(
        &line(1, 10.0),
        &[StopSpec::with_window(30.0, 400.0, 470.0)],
        &[1],
        480.0,
        R,
    )
    .unwrap();
    let s = sol.stops[0];
    assert_eq!(
        (s.arrive_min, s.wait_min, s.late_min, s.depart_min),
        (490.0, 0.0, 20.0, 520.0)
    );
    assert_eq!(sol.late_min, 20.0);
}

#[test]
fn prefers_on_time_over_less_driving() {
    let d = vec![
        vec![0.0, 10.0, 40.0],
        vec![10.0, 0.0, 35.0],
        vec![40.0, 50.0, 0.0],
    ];
    let stops = [
        StopSpec::new(30.0),
        StopSpec::with_window(30.0, 480.0, 525.0),
    ];
    let near_first = evaluate(&d, &stops, &[1, 2], 480.0, R).unwrap();
    let far_first = evaluate(&d, &stops, &[2, 1], 480.0, R).unwrap();
    assert!(near_first.late_min > 0.0 && far_first.late_min == 0.0);
    assert!(far_first.drive_min > near_first.drive_min);
    let sol = solve(&d, &stops, 480.0, R, false).unwrap();
    assert_eq!(sol.order, vec![2, 1]);
    assert_eq!(sol.late_min, 0.0);
}

#[test]
fn lateness_beats_finish_time() {
    let d = vec![
        vec![0.0, 5.0, 10.0],
        vec![60.0, 0.0, 5.0],
        vec![5.0, 60.0, 0.0],
    ];
    let stops = [
        StopSpec::new(10.0),
        StopSpec::with_window(10.0, 480.0, 515.0),
    ];
    let a = evaluate(&d, &stops, &[1, 2], 480.0, R).unwrap();
    let b = evaluate(&d, &stops, &[2, 1], 480.0, R).unwrap();
    assert_eq!(a.late_min, 0.0);
    let best = if internals::is_better(obj(&b), obj(&a)) {
        obj(&b)
    } else {
        obj(&a)
    };
    assert!(approx(
        obj(&solve(&d, &stops, 480.0, R, false).unwrap()),
        best
    ));
    let stops = [
        StopSpec::new(10.0),
        StopSpec::with_window(10.0, 480.0, 495.0),
    ];
    let a = evaluate(&d, &stops, &[1, 2], 480.0, R).unwrap();
    let b = evaluate(&d, &stops, &[2, 1], 480.0, R).unwrap();
    assert!(a.late_min == 5.0 && b.late_min == 0.0 && b.finish_min > a.finish_min);
    assert_eq!(
        solve(&d, &stops, 480.0, R, false).unwrap().order,
        vec![2, 1]
    );
}

#[test]
fn hand_checked_three_stops() {
    let d = vec![
        vec![0.0, 15.0, 25.0, 40.0],
        vec![20.0, 0.0, 12.0, 30.0],
        vec![25.0, 14.0, 0.0, 18.0],
        vec![35.0, 28.0, 20.0, 0.0],
    ];
    let stops = [
        StopSpec::new(30.0),
        StopSpec::with_window(45.0, 540.0, 600.0),
        StopSpec::with_window(20.0, 480.0, 560.0),
    ];
    let sol = evaluate(&d, &stops, &[1, 2, 3], 480.0, R).unwrap();
    let got: Vec<_> = sol
        .stops
        .iter()
        .map(|s| {
            (
                s.index,
                s.leg_drive_min,
                s.arrive_min,
                s.wait_min,
                s.depart_min,
                s.late_min,
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (1, 15.0, 495.0, 0.0, 525.0, 0.0),
            (2, 12.0, 537.0, 3.0, 585.0, 0.0),
            (3, 18.0, 603.0, 0.0, 623.0, 43.0)
        ]
    );
    assert_eq!(
        (sol.end_leg_drive_min, sol.end_arrive_min, sol.finish_min),
        (Some(35.0), Some(658.0), 658.0)
    );
    assert_eq!(
        (sol.drive_min, sol.wait_min, sol.late_min, sol.method),
        (80.0, 3.0, 43.0, Method::Fixed)
    );
    let best = solve(&d, &stops, 480.0, R, false).unwrap();
    assert_eq!(best.late_min, 0.0);
    assert!(approx(obj(&best), brute(&d, &stops, 480.0, R)));
}

#[test]
fn service_times_and_end_modes() {
    let stops: Vec<StopSpec> = [10.0, 20.0, 30.0, 40.0]
        .iter()
        .map(|&s| StopSpec::new(s))
        .collect();
    for end_mode in [EndMode::Return, EndMode::Last] {
        let sol = solve(&line(4, 0.0), &stops, 600.0, end_mode, false).unwrap();
        assert_eq!((sol.finish_min, sol.drive_min), (700.0, 0.0));
    }
    let stops = vec![StopSpec::new(10.0); 3];
    let ret = solve(&line(3, 10.0), &stops, 480.0, R, false).unwrap();
    let last = solve(&line(3, 10.0), &stops, 480.0, EndMode::Last, false).unwrap();
    assert!(last.end_leg_drive_min.is_none() && last.end_arrive_min.is_none());
    assert_eq!(last.finish_min, last.stops.last().unwrap().depart_min);
    assert_eq!((last.order.clone(), last.drive_min), (vec![1, 2, 3], 30.0));
    assert!(ret.end_leg_drive_min.is_some() && Some(ret.finish_min) == ret.end_arrive_min);
    assert_eq!(ret.drive_min, 60.0);
}

#[test]
fn keep_order_and_trivial_cases() {
    let mut rng = Rng(4);
    let (d, stops) = instance(&mut rng, 6, true);
    let sol = solve(&d, &stops, 480.0, R, true).unwrap();
    assert_eq!(
        (sol.order.clone(), sol.method),
        (vec![1, 2, 3, 4, 5, 6], Method::Fixed)
    );
    assert_eq!(
        sol,
        evaluate(&d, &stops, &[1, 2, 3, 4, 5, 6], 480.0, R).unwrap()
    );

    let empty: Vec<Vec<f64>> = vec![vec![0.0]];
    let none = solve(&empty, &[], 480.0, R, false).unwrap();
    assert_eq!(none.method, Method::Trivial);
    assert!(none.order.is_empty() && none.stops.is_empty());
    assert_eq!((none.finish_min, none.drive_min), (480.0, 0.0));
    let none_last = solve(&empty, &[], 480.0, EndMode::Last, false).unwrap();
    assert_eq!(
        (none_last.finish_min, none_last.end_leg_drive_min),
        (480.0, None)
    );
    let one = solve(
        &[vec![0.0, 12.0], vec![9.0, 0.0]],
        &[StopSpec::new(30.0)],
        480.0,
        R,
        false,
    )
    .unwrap();
    assert_eq!((one.method, one.order.clone()), (Method::Trivial, vec![1]));
    assert_eq!(
        (one.stops[0].arrive_min, one.finish_min, one.drive_min),
        (492.0, 492.0 + 30.0 + 9.0, 21.0)
    );
}

#[test]
fn too_many_stops() {
    let err = solve(
        &line(26, 10.0),
        &vec![StopSpec::new(10.0); 26],
        480.0,
        R,
        false,
    )
    .unwrap_err();
    assert!(matches!(&err, RouteError::TooManyStops(m) if m.contains("split the day")));
    assert_eq!((MAX_STOPS, MAX_EXACT), (25, 10));
}

#[test]
fn bad_input() {
    let s10 = StopSpec::new(10.0);
    let bad_f: Vec<(Vec<Vec<f64>>, Vec<StopSpec>)> = vec![
        (vec![vec![0.0, 1.0], vec![1.0, 0.0]], vec![s10, s10]),
        (
            vec![vec![0.0, 1.0, 2.0], vec![1.0, 0.0], vec![2.0, 1.0, 0.0]],
            vec![s10, s10],
        ),
        (vec![vec![0.0, -1.0], vec![1.0, 0.0]], vec![s10]),
        (vec![vec![0.0, f64::NAN], vec![1.0, 0.0]], vec![s10]),
        (vec![vec![0.0, f64::INFINITY], vec![1.0, 0.0]], vec![s10]),
        (
            vec![vec![0.0, 1.0], vec![1.0, 0.0]],
            vec![StopSpec::new(-5.0)],
        ),
        (
            vec![vec![0.0, 1.0], vec![1.0, 0.0]],
            vec![StopSpec::with_window(10.0, 600.0, 540.0)],
        ),
    ];
    for (d, stops) in bad_f {
        assert!(
            matches!(
                solve(&d, &stops, 480.0, R, false),
                Err(RouteError::Invalid(_))
            ),
            "{d:?} {stops:?}"
        );
    }
    let unroutable = vec![vec![Some(0.0), None], vec![Some(1.0), Some(0.0)]];
    let err = solve(&unroutable, &[s10], 480.0, R, false).unwrap_err();
    assert_eq!(err.to_string(), "duration [0][1] is missing");

    let stops = [s10, s10];
    assert!(evaluate(&line(2, 10.0), &stops, &[1, 1], 480.0, R).is_err());
    assert!(evaluate(&line(2, 10.0), &stops, &[0, 1], 480.0, R).is_err());
    assert!(EndMode::parse("loop").is_err());
    assert!(solve(&line(2, 10.0), &stops, f64::NAN, R, false).is_err());
}
