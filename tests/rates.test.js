// 測試組 G：費率表連動下拉與查價（lib/rates.js），用精簡費率表
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/rates.js');

const T = [
    { tutor: '資深導師', instrument: 'Classical Guitar', grade: 'Grade 5', classType: '一對一個別授課 Individual', duration: 30, rate: 310 },
    { tutor: '資深導師', instrument: 'Classical Guitar', grade: 'Grade 5', classType: '一對一個別授課 Individual', duration: 45, rate: 420 },
    { tutor: '資深導師', instrument: 'Classical Guitar', grade: 'Grade 5', classType: '2人小組授課', duration: 60, rate: 320 },
    { tutor: '資深導師', instrument: 'Classical Guitar', grade: 'Grade 5', classType: '3-4人小組授課', duration: 60, rate: 215 },
    { tutor: '資深導師', instrument: 'Classical Guitar', grade: 'Grade 6', classType: '一對一個別授課 Individual', duration: 30, rate: '' }, // 無定價
    { tutor: '資深導師', instrument: 'Classical Guitar', grade: 'Grade 6', classType: '一對一個別授課 Individual', duration: 45, rate: 420 },
    { tutor: '資深導師', instrument: 'Classical Guitar', grade: 'Grade 7', classType: '一對一個別授課 Individual', duration: 60, rate: 620 },
    { tutor: '普通導師', instrument: 'Pop Guitar', grade: 'Elementary 初級', classType: '一對一個別授課 Individual', duration: 45, rate: 320 },
    { tutor: '普通導師', instrument: 'Pop Guitar', grade: 'Debut 入門', classType: '一對一個別授課 Individual', duration: 45, rate: 280 }
];

test('G1: 上課形式短形式 ↔ 費率表標籤雙向對應（小組課 5人小組 → 3-4人小組授課）', () => {
    assert.strictEqual(R.studentTypeToClassType('一對一'), '一對一個別授課 Individual');
    assert.strictEqual(R.studentTypeToClassType('2人小組'), '2人小組授課');
    assert.strictEqual(R.studentTypeToClassType('3-4人小組'), '3-4人小組授課');
    assert.strictEqual(R.studentTypeToClassType('5人小組'), '3-4人小組授課');
    assert.strictEqual(R.classTypeToStudentType('一對一個別授課 Individual'), '一對一');
    assert.strictEqual(R.classTypeToStudentType('3-4人小組授課'), '3-4人小組');
});

test('G2: optionsFor 只列有定價的組合、依連動前綴過濾、級別按固定順序', () => {
    assert.deepStrictEqual(R.optionsFor(T, {}, 'tutorLevel'), ['資深導師', '普通導師']);
    assert.deepStrictEqual(R.optionsFor(T, { tutorLevel: '普通導師' }, 'program'), ['Pop Guitar']);
    assert.deepStrictEqual(R.optionsFor(T, { tutorLevel: '普通導師', program: 'Pop Guitar' }, 'level'), ['Debut 入門', 'Elementary 初級'], 'Debut 排最前');
    assert.deepStrictEqual(R.optionsFor(T, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 5' }, 'type'), ['一對一', '2人小組', '3-4人小組']);
    assert.deepStrictEqual(R.optionsFor(T, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 6', type: '一對一' }, 'duration'), [45], '30 分鐘無定價不列');
    assert.deepStrictEqual(R.optionsFor(T, { tutorLevel: '資深導師', program: 'Music Theory' }, 'level'), [], '不在表內 → 空');
});

test('G3: findRate 精確查價；無定價／不存在回 null', () => {
    assert.strictEqual(R.findRate(T, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 5', type: '3-4人小組', duration: 60 }), 215);
    assert.strictEqual(R.findRate(T, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 5', type: '一對一', duration: '45' }), 420, '時長字串也可');
    assert.strictEqual(R.findRate(T, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 6', type: '一對一', duration: 30 }), null);
    assert.strictEqual(R.findRate(T, { tutorLevel: '普通導師', program: 'Classical Guitar', level: 'Grade 5', type: '一對一', duration: 45 }), null);
});

test('G4: resolve 連動——下游失效改為第一個可選；合法組合原樣保留並給價', () => {
    const ok = R.resolve(T, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 5', type: '2人小組', duration: 60 });
    assert.deepStrictEqual(ok.sel, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 5', type: '2人小組', duration: 60 });
    assert.strictEqual(ok.rate, 320);
    // 升到 Grade 7：只有一對一 60 分鐘 → 形式與時長跟著改
    const up = R.resolve(T, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 7', type: '2人小組', duration: 45 });
    assert.deepStrictEqual(up.sel, { tutorLevel: '資深導師', program: 'Classical Guitar', level: 'Grade 7', type: '一對一', duration: 60 });
    assert.strictEqual(up.rate, 620);
    assert.deepStrictEqual(up.options.type, ['一對一']);
    assert.deepStrictEqual(up.options.duration, [60]);
    // 換導師級別：課程不在該級別的表 → 改為第一個可選課程
    const sw = R.resolve(T, { tutorLevel: '普通導師', program: 'Classical Guitar', level: 'Grade 5', type: '一對一', duration: 45 });
    assert.strictEqual(sw.sel.program, 'Pop Guitar');
    assert.strictEqual(sw.sel.level, 'Debut 入門');
    assert.strictEqual(sw.rate, 280);
    // 空選擇 → 全部取第一個可選
    const empty = R.resolve(T, {});
    assert.strictEqual(empty.sel.tutorLevel, '資深導師');
    assert.strictEqual(empty.rate, 310);
});
