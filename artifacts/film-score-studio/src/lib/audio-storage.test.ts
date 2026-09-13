import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioStorageDatabaseName } from './audio-storage.ts';

describe('audio-storage', () => {
    it('uses an isolated IndexedDB database for each authenticated user', () => {
        assert.notEqual(audioStorageDatabaseName('user_alice'), audioStorageDatabaseName('user_bob'));
        assert.equal(audioStorageDatabaseName('user_alice'), 'FilmScoreStudioAudio:user_alice');
    });

    it('does not expose an unscoped legacy audio cache', () => {
        assert.throws(() => audioStorageDatabaseName(null as unknown as string), /authenticated audio cache scope/);
    });
});
