"""Deterministic races against the actual descriptor-relative broker."""
import importlib.util
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('broker', pathlib.Path(__file__).parents[1] / 'src/agents/workspace-filesystem.py')
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class DescriptorBoundary(unittest.TestCase):
    @unittest.skipUnless(os.chmod in os.supports_follow_symlinks, 'platform uses the O_PATH cleanup branch')
    def test_cleanup_permission_repair_does_not_follow_a_swapped_link(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            owned = base / 'owned'
            owned.mkdir(mode=0)
            outside = base / 'sentinel'
            outside.write_text('untouched')
            outside.chmod(0o640)
            original = os.chmod
            swapped = False

            def race(name, mode, *args, **kwargs):
                nonlocal swapped
                if name == 'owned':
                    os.rmdir(owned)
                    owned.symlink_to(outside)
                    swapped = True
                return original(name, mode, *args, **kwargs)

            # Preserve capability membership when mocking the function object.
            with patch.object(os, 'chmod', race), patch.object(os, 'supports_follow_symlinks', {race}):
                with self.assertRaises(OSError):
                    broker.execute(dict(root=directory, operation='cleanup', path='owned'))
            self.assertTrue(swapped)
            self.assertEqual(outside.stat().st_mode & 0o777, 0o640)
            self.assertEqual(outside.read_text(), 'untouched')

    def test_cleanup_unreadable_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'owned'
            path.mkdir(mode=0)
            try:
                broker.execute(dict(root=directory, operation='cleanup', path='owned'))
                self.assertFalse(path.exists())
            finally:
                if path.exists():
                    path.chmod(0o700)

    def test_replaced_parent_never_redirects_read_write_edit_or_grep(self):
        for operation in ('read', 'write', 'edit', 'grep'):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                base = pathlib.Path(directory)
                root = base / 'workspace'
                nested = root / 'scratch/nested'
                nested.mkdir(parents=True)
                outside = base / 'outside'
                outside.mkdir()
                (nested / 'secret').write_text('inside sentinel')
                (outside / 'secret').write_text('outside sentinel')
                original = os.open
                swapped = False

                def race(name, flags, *args, **kwargs):
                    nonlocal swapped
                    fd = original(name, flags, *args, **kwargs)
                    if name == 'nested' and not swapped:
                        swapped = True
                        nested.rename(root / 'scratch/held')
                        nested.symlink_to(outside, target_is_directory=True)
                    return fd

                request = dict(root=str(root), operation=operation,
                               path='scratch/nested/secret', content='replacement',
                               oldText='inside', newText='updated', pattern='sentinel')
                with patch.object(os, 'open', race):
                    try:
                        result = broker.execute(request)
                        self.assertNotIn('outside sentinel', str(result))
                    except (OSError, broker.Rejected):
                        pass  # A changed path may fail closed; never follow it.
                self.assertTrue(swapped)
                self.assertEqual((outside / 'secret').read_text(), 'outside sentinel')

    def test_temporary_name_collision_does_not_follow_link(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / 'workspace/scratch').mkdir(parents=True)
            outside = base / 'sentinel'
            outside.write_text('untouched')
            (base / 'workspace/scratch/.chimera-collision.tmp').symlink_to(outside)
            with patch.object(broker.secrets, 'token_hex', return_value='collision'):
                with self.assertRaises(FileExistsError):
                    broker.execute(dict(root=str(base / 'workspace'), operation='write', path='scratch/result', content='overwrite'))
            self.assertEqual(outside.read_text(), 'untouched')


if __name__ == '__main__':
    unittest.main()
