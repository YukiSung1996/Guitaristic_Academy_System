'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('demo_data.js：與 data.js 同時載入不衝突；demoStudents／demoGroups／demoTutors 結構完整（演示情境：14 人、1 個五人小組、A／B 兩位導師）', () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8'), ctx, { filename: 'data.js' });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'demo_data.js'), 'utf8'), ctx, { filename: 'demo_data.js' });
    const { demoStudents, demoGroups, demoTutors } = vm.runInContext('({ demoStudents, demoGroups, demoTutors })', ctx);
    assert.strictEqual(demoStudents.length, 14);
    demoStudents.forEach(s => ['id', 'name', 'tutor', 'program', 'level', 'type'].forEach(k => assert.strictEqual(typeof s[k], 'string', s.id + '.' + k)));
    assert.strictEqual(demoStudents.filter(s => s.weekday === null).length, 3, '三位只上小組');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demoGroups.map(g => g.id + ':' + g.memberIds.length))), ['G01:5']); // vm 另一 realm 的陣列：JSON 轉一次再比
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demoTutors.map(t => t.name + ':' + t.tier))), ['Instructor A:普通導師', 'Instructor B:資深導師']);
    assert.strictEqual(vm.runInContext('typeof groupCourses', ctx), 'object', 'data.js 自己的舊 groupCourses 仍在');
    assert.ok(!/default(Students|Groups|Tutors)\s*=/.test(fs.readFileSync(path.join(__dirname, '..', 'demo_data.js'), 'utf8')), 'demo_data.js 不宣告 default*');
});
