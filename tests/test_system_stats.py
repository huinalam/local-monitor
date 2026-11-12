import unittest
from unittest.mock import patch
from local_monitor.system_stats import SystemStats,cpu_percent,memory_stats,swap_stats

class SystemTests(unittest.TestCase):
    def test_cpu_delta(self):
        self.assertIsNone(cpu_percent(None,[1,2,3,4]))
        self.assertEqual(cpu_percent([10,20,30,0],[20,30,110,0]),20)
        self.assertEqual(cpu_percent([0,0,0,0],[10,20,0,0]),100)
        self.assertIsNone(cpu_percent([1,2,3,4],[1,2,3,4]))
    def test_memory_estimate(self):
        text='page size of 4096 bytes\nPages active: 20.\nPages inactive: 10.\nPages wired down: 10.\nPages occupied by compressor: 5.\nFile-backed pages: 10.\nPages purgeable: 5.\n'
        self.assertEqual(memory_stats(text,409600)['memory_percent'],30)
    def test_swap_units_and_missing_values(self):
        self.assertEqual(swap_stats('total = 2.00G used = 512.00M free = 1.50G'),
                         dict(swap_total=2*1024**3,swap_used=512*1024**2))
        self.assertEqual(swap_stats('total = 0.00M used = 0.00M')['swap_used'],0)
        self.assertEqual(swap_stats('used = 1024.00K')['swap_used'],1024**2)
        self.assertIsNone(swap_stats('unavailable')['swap_used'])
        self.assertIsNone(swap_stats('used = 1.00G')['swap_total'])
    def test_failure_and_stale(self):
        s=SystemStats()
        with patch('local_monitor.system_stats.ctypes.CDLL',side_effect=OSError):s.sample()
        self.assertEqual(s.read()['status'],'unavailable')
        s.value={'status':'ok','observed_at':10,'cpu_percent':20}
        with patch('local_monitor.system_stats.time.time',return_value=41):self.assertEqual(s.read()['status'],'unavailable')

    def test_history_closed_buckets_average_unknown_and_gap(self):
        s=SystemStats()
        for at,cpu,ram in [(100,None,40),(102,20,60),(110,50,80),(140,90,50)]:
            s.record(dict(observed_at=at,cpu_percent=cpu,memory_percent=ram,swap_used=0))
        with patch('local_monitor.system_stats.time.time',return_value=140):
            result=s.read_history()
            self.assertEqual([p['at'] for p in result],[100,110])
            self.assertEqual(result[0]['cpu_percent'],20)
            self.assertEqual(result[0]['memory_percent'],50)
            self.assertEqual(result[0]['swap_used'],0)
            result[0]['cpu_percent']=999
            self.assertEqual(s.read_history()[0]['cpu_percent'],20)
        s=SystemStats();s.record(dict(observed_at=100,cpu_percent=None));s.record(dict(observed_at=110))
        self.assertIsNone(s.history[0]['cpu_percent'])

    def test_history_retention_failure_gap_and_clock_rollback(self):
        s=SystemStats()
        for at in range(100,2110,10):s.record(dict(observed_at=at,cpu_percent=50))
        self.assertEqual(len(s.history),180)
        with patch('local_monitor.system_stats.time.time',return_value=4000):self.assertEqual(s.read_history(),[])
        with patch('local_monitor.system_stats.ctypes.CDLL',side_effect=OSError):s.sample()
        self.assertEqual(len(s.history),180) # failure never invents samples
        s.record(dict(observed_at=90,cpu_percent=20))
        self.assertEqual(list(s.history),[])
        s.record(dict(observed_at=100,cpu_percent=30))
        self.assertEqual(s.history[0]['at'],90)

    def test_failure_keeps_lastgood_and_sanitizes_diagnostics(self):
        import subprocess
        s=SystemStats();s.value=dict(status='ok',observed_at=90,cpu_percent=21,memory_percent=63,swap_used=1024)
        error=subprocess.TimeoutExpired(['secret-command','token-secret'],1,output='sensitive-output')
        with patch('local_monitor.system_stats.time.time',return_value=100),self.assertLogs('local_monitor.system_stats',level='INFO') as logs:
            s.failed('memory',error)
        value=s.read()
        self.assertEqual(value['observed_at'],90)
        self.assertEqual(value['cpu_percent'],21)
        self.assertEqual(value['memory_percent'],63)
        self.assertEqual(value['swap_used'],1024)
        self.assertEqual(value['last_error'],dict(at=100,stage='memory',reason='timeout',type='TimeoutExpired'))
        self.assertEqual(value['consecutive_failures'],1)
        self.assertEqual(list(s.history),[])
        self.assertNotIn('secret',' '.join(logs.output))
        self.assertNotIn('sensitive',' '.join(logs.output))
        value['last_error']['stage']='mutated'
        self.assertEqual(s.read()['last_error']['stage'],'memory')

    def test_diagnostics_throttle_recovery_and_new_failure(self):
        s=SystemStats()
        with patch('local_monitor.system_stats.time.time',return_value=100),self.assertLogs('local_monitor.system_stats',level='INFO') as logs:
            s.failed('cpu',OSError('secret'))
            s.failed('cpu',OSError('secret'))
            self.assertEqual(len(logs.output),1)
        with patch('local_monitor.system_stats.time.time',return_value=160),self.assertLogs('local_monitor.system_stats',level='INFO'):
            s.failed('cpu',OSError())
        with self.assertLogs('local_monitor.system_stats',level='INFO') as logs:
            s.succeeded(dict(status='ok',observed_at=161,cpu_percent=30,memory_percent=70,swap_used=0))
            self.assertIn('recovery',logs.output[0])
            self.assertIn('3',logs.output[0])
        with patch('local_monitor.system_stats.time.time',return_value=162):
            value=s.read();self.assertEqual(value['status'],'ok')
            self.assertEqual(value['consecutive_failures'],0)
            self.assertEqual(value['last_error']['at'],160)
            with self.assertLogs('local_monitor.system_stats',level='WARNING'):s.failed('cpu',OSError())
        with patch('local_monitor.system_stats.time.time',return_value=163),self.assertLogs('local_monitor.system_stats',level='WARNING'):
            s.failed('swap',ValueError('private output'))
        self.assertEqual(s.read()['last_error']['reason'],'invalid_data')

    def test_ten_second_worker_and_thirty_second_freshness(self):
        from unittest.mock import Mock
        stop=Mock();stop.is_set.side_effect=[False,False,True]
        s=SystemStats()
        with patch.object(s,'sample') as sample:
            thread=s.start(stop);thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(sample.call_count,2)
            self.assertEqual([call.args for call in stop.wait.call_args_list],[(10,),(10,)])
        s.value=dict(status='ok',observed_at=100,cpu_percent=20)
        for now,expected in [(110,'ok'),(130,'ok'),(131,'unavailable')]:
            with patch('local_monitor.system_stats.time.time',return_value=now):
                self.assertEqual(s.read()['status'],expected)
