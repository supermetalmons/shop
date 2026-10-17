import json
from pathlib import Path
import unittest
from unittest.mock import patch

import test_catalog as fixtures
import catalog
from prepare import atomic_json


class PipelineTests(unittest.TestCase):
    setUp = fixtures.CatalogTests.setUp
    tearDown = fixtures.CatalogTests.tearDown
    execution = fixtures.CatalogTests.execution
    publication = fixtures.CatalogTests.publication

    def run_pipeline(self, *, stop_after_start=None, request_before=False, fail_card=None, reattach=False, saved_stopped=False):
        events, counts = [], {}
        active_counts, updates = [], []
        publication = catalog.empty_manifest(self.job)
        request = self.root / 'stop-after-card.json'
        if request_before:
            atomic_json(request, {'jobId': self.job['jobId']})
        def start(state, logical, metadata, context, backend, active):
            card = context['execution']['job']['ids'][0]
            events.append(('start', card))
            active_counts.append(len(active))
            context.update({'previousAttempt': None, 'current': None})
            if card == stop_after_start:
                atomic_json(request, {'jobId': self.job['jobId']})
        def poll(state, logical, context, backend):
            card = context['execution']['job']['ids'][0]
            counts[card] = counts.get(card, 0) + 1
            if card == fail_card:
                raise RuntimeError('CPU worker failed')
            context['current'] = {'status': 'processing' if counts[card] >= 2 else 'rendering',
                                  'captureReleased': counts[card] >= 2}
            events.append(('poll', card))
            return counts[card] >= (7 if card == 1 else 3)
        def publish(state, job, metadata, execution, manifest):
            card = execution['job']['ids'][0]
            events.append(('publish', card))
            manifest['videos'][str(card)] = {'backend': 'host'}
            manifest['status'] = 'complete' if len(manifest['videos']) == len(job['ids']) else 'pending'
        with patch.object(catalog, 'pipeline_capability', return_value=True):
            if reattach or saved_stopped:
                contexts = [{'execution': self.execution('host', card)} for card in (1, 2)]
                catalog.save_active_executions(self.state, self.job, contexts)
            with patch.object(catalog, 'start_pipeline_execution', side_effect=start), \
                    patch.object(catalog, 'poll_pipeline_execution', side_effect=poll), \
                    patch.object(catalog, 'capture_released', side_effect=lambda job, current: current['captureReleased']), \
                    patch.object(catalog, 'publish_card', side_effect=publish), patch.object(catalog, 'check_capacity'), \
                    patch.object(catalog, 'cleanup_available'), patch.object(catalog, 'native_running', return_value=reattach), \
                    patch.object(catalog, 'stop_native') as stop, patch.object(catalog.time, 'sleep'):
                if fail_card:
                    with self.assertRaisesRegex(RuntimeError, 'CPU worker failed'):
                        catalog.run_pipeline(self.state, self.job, self.metadata, self.job['ids'], self.backend,
                                             {self.job['sourceId']: self.prepared}, publication, lambda: False,
                                             lambda *args, **kwargs: updates.append((args, kwargs)))
                    return events, active_counts, updates, stop.call_args_list
                result = catalog.run_pipeline(self.state, self.job, self.metadata, self.job['ids'], self.backend,
                                              {self.job['sourceId']: self.prepared}, publication, lambda: False,
                                              lambda *args, **kwargs: updates.append((args, kwargs)))
        return events, active_counts, updates, result

    def test_pipeline_overlaps_after_release_and_never_exceeds_two_unpublished_cards(self):
        events, counts, updates, complete = self.run_pipeline()
        self.assertTrue(complete)
        self.assertEqual(max(counts), 2)
        self.assertLess(events.index(('start', 2)), events.index(('publish', 1)))
        self.assertGreater(events.index(('start', 2)), events.index(('poll', 1)))
        self.assertEqual([card for event, card in events if event == 'publish'], [1, 2, 3])
        self.assertGreater(events.index(('start', 3)), events.index(('publish', 1)))
        self.assertGreater(events.index(('start', 3)), events.index(('publish', 2)))
        self.assertEqual(catalog.active_executions(self.state, self.job), [])

    def test_stop_request_drains_both_started_cards_without_creating_a_third(self):
        events, counts, updates, complete = self.run_pipeline(stop_after_start=2)
        self.assertFalse(complete)
        self.assertEqual([card for event, card in events if event == 'publish'], [1, 2])
        self.assertNotIn(('start', 3), events)
        self.assertFalse(catalog.execution_directory(self.state, self.job, 'host', 3).exists())
        self.assertFalse((self.root / 'stop-after-card.json').exists())
        self.assertEqual(updates[-1][1]['stoppedAfterCard'], 2)

    def test_stop_request_saved_before_resume_finishes_only_one_card(self):
        events, counts, updates, complete = self.run_pipeline(request_before=True)
        self.assertFalse(complete)
        self.assertEqual([card for event, card in events if event == 'start'], [1])
        self.assertEqual([card for event, card in events if event == 'publish'], [1])

    def test_failed_worker_stops_only_both_owned_executions_and_preserves_checkpoints(self):
        events, counts, updates, stopped = self.run_pipeline(fail_card=2)
        self.assertEqual([call.args[1]['ids'][0] for call in stopped], [1, 2])
        self.assertEqual([entry['currentCard'] for entry in catalog.active_executions(self.state, self.job)], [1, 2])
        self.assertNotIn(('start', 3), events)
        self.assertTrue((catalog.execution_directory(self.state, self.job, 'host', 1) / 'execution.json').exists())
        self.assertTrue((catalog.execution_directory(self.state, self.job, 'host', 2) / 'execution.json').exists())

    def test_resume_reattaches_both_saved_executions_and_keeps_publication_order(self):
        events, counts, updates, complete = self.run_pipeline(reattach=True)
        self.assertTrue(complete)
        self.assertEqual([card for event, card in events if event == 'start'], [1, 2, 3])
        self.assertEqual([card for event, card in events if event == 'publish'], [1, 2, 3])

    def test_two_interrupted_executions_resume_capture_serially(self):
        events, counts, updates, complete = self.run_pipeline(saved_stopped=True)
        self.assertTrue(complete)
        self.assertEqual([card for event, card in events if event == 'start'], [1, 2, 3])
        self.assertGreater(events.index(('start', 2)), events.index(('poll', 1)))
        self.assertEqual(max(counts), 2)

    def test_failed_drain_preserves_boundary_request_for_resume(self):
        self.run_pipeline(fail_card=2, stop_after_start=2)
        self.assertTrue((self.root / 'stop-after-card.json').exists())

    def assert_published_boundary_recovery(self, failure):
        with patch.object(catalog, 'pipeline_capability', return_value=True):
            execution = self.execution('host', 1)
        catalog.save_active_executions(self.state, self.job, [{'execution': execution}])
        catalog.request_interrupt(self.state, self.job['name'], after_card=True)
        publication = self.publication(execution)
        manifest = catalog.empty_manifest(self.job)
        publish_card = catalog.publish_card
        def publish(*args):
            publish_card(*args)
            if failure == 'publication':
                raise OSError('crash after publication')
        with patch('collect.verify_publication', return_value=publication), \
                patch.object(catalog, 'start_pipeline_execution'), patch.object(catalog, 'poll_pipeline_execution', return_value=True), \
                patch.object(catalog, 'publish_card', side_effect=publish), patch.object(catalog, 'check_capacity'), \
                patch.object(catalog, 'cleanup_available', side_effect=OSError('crash during cleanup') if failure == 'cleanup' else None), \
                patch.object(catalog, 'native_running', return_value=False), patch.object(catalog, 'stop_native'), \
                patch.object(catalog.time, 'sleep'), self.assertRaisesRegex(OSError, 'crash'):
            catalog.run_pipeline(self.state, self.job, self.metadata, self.job['ids'], self.backend,
                                 {self.job['sourceId']: self.prepared}, manifest, lambda: False, lambda *args, **kwargs: None)
        self.assertEqual([entry['currentCard'] for entry in catalog.active_executions(self.state, self.job)],
                         [1] if failure == 'publication' else [])
        self.assertEqual(catalog.read(self.root / 'stop-after-card.json')['throughCard'], 1)
        saved_manifest = catalog.manifest_path(self.metadata).read_bytes()
        saved_video = (Path(self.metadata['output']) / '1.mp4').read_bytes()
        with patch('collect.verify_publication', return_value=publication), \
                patch.object(catalog, 'ensure_other_idle'), patch.object(catalog, 'ensure_exclusive_native'), \
                patch.object(catalog, 'backend_for') as backend, patch.object(catalog, 'start_pipeline_execution') as start:
            self.assertEqual(catalog.run(self.state, self.job['name'], 'host'), 0)
        backend.assert_not_called()
        start.assert_not_called()
        self.assertEqual(catalog.manifest_path(self.metadata).read_bytes(), saved_manifest)
        self.assertEqual((Path(self.metadata['output']) / '1.mp4').read_bytes(), saved_video)
        self.assertEqual(catalog.status(self.state, self.job['name'])['stoppedAfterCard'], 1)
        self.assertFalse((self.root / 'stop-after-card.json').exists())
        self.assertEqual(catalog.active_executions(self.state, self.job), [])
        self.assertFalse(catalog.execution_directory(self.state, self.job, 'host', 2).exists())

    def test_boundary_survives_crash_after_publication_before_active_update(self):
        self.assert_published_boundary_recovery('publication')

    def test_boundary_survives_cleanup_failure_after_active_inventory_is_cleared(self):
        self.assert_published_boundary_recovery('cleanup')

    def test_pipeline_capability_does_not_change_old_or_vm_execution_identity(self):
        old = self.execution('host', 1)
        self.assertNotIn('pipeline', old['job'])
        with patch.object(catalog, 'pipeline_capability', return_value=True):
            new = self.execution('host', 2)
            vm = self.execution('vm', 3)
        self.assertEqual(new['job']['pipeline'], {'version': 1, 'catalogJobId': self.job['jobId'], 'maxUnfinished': 2})
        self.assertNotIn('pipeline', vm['job'])
        self.assertEqual(self.execution('host', 1), old)

    def test_release_requires_current_attempt_immutable_marker_and_released_capture_lock(self):
        with patch.object(catalog, 'pipeline_capability', return_value=True):
            job = self.execution('host', 1)['job']
        path = Path(job['root']) / 'cards/1/capture-complete.json'
        marker = {key: job[key] for key in ('jobId', 'sourceId', 'profile', 'motion')}
        marker.update({'attempt': 'current', 'cardId': 1, 'safariReleased': True})
        atomic_json(path, marker)
        current = {'attempt': 'current', 'captureReleased': {'path': str(path), 'sha256': catalog.file_hash(path), 'attempt': 'current'}}
        self.assertTrue(catalog.capture_released(job, current))
        self.assertFalse(catalog.capture_released(job, {**current, 'attempt': 'restarted'}))
        lock = Path(job['root']).parent.parent / 'render.lock/owner.json'
        atomic_json(lock, {'jobId': job['jobId']})
        self.assertFalse(catalog.capture_released(job, current))
        lock.unlink()
        path.write_text(json.dumps({**marker, 'sourceId': 'f' * 64}))
        with self.assertRaisesRegex(ValueError, 'release identity changed'):
            catalog.capture_released(job, current)

    def test_interrupt_targets_every_saved_execution_even_after_supervisor_failure(self):
        with patch.object(catalog, 'pipeline_capability', return_value=True):
            contexts = [{'execution': self.execution('host', card)} for card in (1, 2)]
        catalog.save_active_executions(self.state, self.job, contexts)
        atomic_json(self.root / 'catalog-state.json', {'status': 'failed', 'backend': 'host', 'currentCard': None})
        with patch.object(catalog, 'backend_for', return_value=self.backend), patch.object(catalog, 'stop_native') as stop:
            catalog.request_interrupt(self.state, self.job['name'])
        self.assertEqual([call.args[1]['ids'][0] for call in stop.call_args_list], [1, 2])


if __name__ == '__main__':
    unittest.main()
