use std::{collections::HashMap, future::Future, sync::{Arc, Mutex, Weak}};
use tokio::sync::OnceCell;

/// Share only overlapping reads. Completed results are not a freshness cache.
pub(super) struct SingleFlight<T> {
    pending: Mutex<HashMap<String, Weak<OnceCell<T>>>>,
}

impl<T: Clone> SingleFlight<T> {
    pub fn new() -> Self {
        Self { pending: Mutex::new(HashMap::new()) }
    }

    pub async fn run<F: Future<Output = T>>(&self, key: String, fetch: impl FnOnce() -> F) -> T {
        let cell = {
            let mut pending = self.pending.lock().expect("usage request map poisoned");
            pending.retain(|_, entry| entry.strong_count() > 0);
            match pending.get(&key).and_then(Weak::upgrade) {
                Some(cell) => cell,
                None => {
                    let cell = Arc::new(OnceCell::new());
                    pending.insert(key.clone(), Arc::downgrade(&cell));
                    cell
                }
            }
        };
        let value = cell.get_or_init(fetch).await.clone();
        let mut pending = self.pending.lock().expect("usage request map poisoned");
        if pending.get(&key).is_some_and(|entry| entry.ptr_eq(&Arc::downgrade(&cell))) {
            pending.remove(&key);
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn overlapping_reads_share_errors_but_later_reads_retry() {
        let flights = SingleFlight::new();
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Err::<u32, _>("offline".to_owned())
        };
        let (a, b) = tokio::join!(flights.run("a".into(), fetch), flights.run("a".into(), fetch));
        assert_eq!(a, b);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(flights.run("a".into(), || async { Ok(7) }).await, Ok(7));
        assert!(flights.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn distinct_accounts_do_not_block_each_other() {
        let flights = SingleFlight::new();
        let gate = tokio::sync::Notify::new();
        let (a, b) = tokio::join!(
            flights.run("a".into(), || async { gate.notified().await; 1 }),
            flights.run("b".into(), || async { gate.notify_one(); 2 })
        );
        assert_eq!((a, b), (1, 2));
    }

    #[tokio::test]
    async fn cancelled_initializer_can_be_retried() {
        // An independently cancelled future leaves only a weak map entry.
        let flights = SingleFlight::<u32>::new();
        { let request = flights.run("a".into(), || std::future::pending());
          tokio::pin!(request);
          assert!(futures::poll!(&mut request).is_pending()); }
        assert_eq!(flights.run("a".into(), || async { 3 }).await, 3);
    }
}
