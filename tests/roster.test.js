'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ST = require('../lib/storage.js');

test('tutorsFromRoster：從學生／小組的 tutor／tutorLevel 推出導師名單——去重、按出現次序、只有「資深導師」算資深、空名略過', () => {
    const students = [{ tutor: 'A', tutorLevel: '普通導師' }, { tutor: 'B', tutorLevel: '資深導師' }, { tutor: 'A', tutorLevel: '資深導師' }, { tutor: '' }, {}, null];
    const groups = [{ tutor: 'C' }, { tutor: 'B' }];
    assert.deepStrictEqual(ST.tutorsFromRoster(students, groups), [{ name: 'A', tier: '普通導師' }, { name: 'B', tier: '資深導師' }, { name: 'C', tier: '普通導師' }]);
    assert.deepStrictEqual(ST.tutorsFromRoster(null, null), []);
});
