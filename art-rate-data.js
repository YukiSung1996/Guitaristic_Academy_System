const TUTOR_OPTIONS = ["普通導師", "資深導師"];
    const PROGRAM_OPTIONS = ["Classical Guitar", "Pop Guitar", "Hymns Guitar", "Fingerstyle Guitar", "Acoustic Guitar"];
    const GRADE_OPTIONS = [
        "Pre Grade", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7", "Grade 8", "ATCL/Dip/ ABRSM",
        "Debut 入門", "Elementary 初級", "Intermediate 中級", "Advanced 高級"
    ];
    const CLASS_TYPE_OPTIONS = ["一對一個別授課 Individual", "2人小組授課", "3-4人小組授課"];
    const DURATION_OPTIONS = [30, 45, 60];
    const DISCOUNT_OPTIONS = [
        { label: "原價 (100%)", value: 1.0 },
        { label: "九折 (90%)", value: 0.9 },
        { label: "半折 (50%)", value: 0.5 }
    ];

        // Calendar event status codes. They may appear in SUMMARY, DESCRIPTION or LOCATION.
        const CALENDAR_STATUS_CODES = {
            leave: {
                L: "Leave",
                SL: "Sick Leave",
                TL: "Tutor Leave"
            },
            makeup: "MU",
            noShow: "NS"
        };

    // Rates Table Data
    const rateTable = [
      // 資深導師 - Classical Guitar
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "2人小組授課", duration: 60, rate: 275 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "3-4人小組授課", duration: 60, rate: 180 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 1", classType: "2人小組授課", duration: 60, rate: 275 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 1", classType: "3-4人小組授課", duration: 60, rate: 180 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 2", classType: "2人小組授課", duration: 60, rate: 275 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 2", classType: "3-4人小組授課", duration: 60, rate: 180 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 3", classType: "一對一個別授課 Individual", duration: 30, rate: 280 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 3", classType: "一對一個別授課 Individual", duration: 45, rate: 385 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 3", classType: "一對一個別授課 Individual", duration: 60, rate: 480 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 3", classType: "2人小組授課", duration: 60, rate: 290 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 3", classType: "3-4人小組授課", duration: 60, rate: 190 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 4", classType: "一對一個別授課 Individual", duration: 30, rate: 280 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 4", classType: "一對一個別授課 Individual", duration: 45, rate: 385 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 4", classType: "一對一個別授課 Individual", duration: 60, rate: 480 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 4", classType: "2人小組授課", duration: 60, rate: 290 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 4", classType: "3-4人小組授課", duration: 60, rate: 190 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 5", classType: "一對一個別授課 Individual", duration: 30, rate: 310 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 5", classType: "一對一個別授課 Individual", duration: 45, rate: 420 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 5", classType: "一對一個別授課 Individual", duration: 60, rate: 530 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 5", classType: "2人小組授課", duration: 60, rate: 320 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 5", classType: "3-4人小組授課", duration: 60, rate: 215 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 6", classType: "一對一個別授課 Individual", duration: 45, rate: 420 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 6", classType: "一對一個別授課 Individual", duration: 60, rate: 530 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 6", classType: "2人小組授課", duration: 60, rate: 320 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 6", classType: "3-4人小組授課", duration: 60, rate: 215 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 7", classType: "一對一個別授課 Individual", duration: 45, rate: 500 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 7", classType: "一對一個別授課 Individual", duration: 60, rate: 620 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 8", classType: "一對一個別授課 Individual", duration: 45, rate: 500 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "Grade 8", classType: "一對一個別授課 Individual", duration: 60, rate: 620 },
      { tutor: "資深導師", instrument: "Classical Guitar", grade: "ATCL/Dip/ ABRSM", classType: "一對一個別授課 Individual", duration: 60, rate: 700 },

      // 資深導師 - Pop / Hymns / Fingerstyle Guitar
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Elementary 初級", classType: "2人小組授課", duration: 60, rate: 275 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Elementary 初級", classType: "3-4人小組授課", duration: 60, rate: 180 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 30, rate: 310 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 45, rate: 420 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 60, rate: 530 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Intermediate 中級", classType: "2人小組授課", duration: 60, rate: 320 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Intermediate 中級", classType: "3-4人小組授課", duration: 60, rate: 215 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Advanced 高級", classType: "一對一個別授課 Individual", duration: 45, rate: 500 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Advanced 高級", classType: "一對一個別授課 Individual", duration: 60, rate: 620 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Advanced 高級", classType: "2人小組授課", duration: 60, rate: 380 },
      { tutor: "資深導師", instrument: "Pop Guitar", grade: "Advanced 高級", classType: "3-4人小組授課", duration: 60, rate: 250 },

      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Elementary 初級", classType: "2人小組授課", duration: 60, rate: 275 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Elementary 初級", classType: "3-4人小組授課", duration: 60, rate: 180 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 30, rate: 310 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 45, rate: 420 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 60, rate: 530 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Intermediate 中級", classType: "2人小組授課", duration: 60, rate: 320 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Intermediate 中級", classType: "3-4人小組授課", duration: 60, rate: 215 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Advanced 高級", classType: "一對一個別授課 Individual", duration: 45, rate: 500 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Advanced 高級", classType: "一對一個別授課 Individual", duration: 60, rate: 620 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Advanced 高級", classType: "2人小組授課", duration: 60, rate: 380 },
      { tutor: "資深導師", instrument: "Hymns Guitar", grade: "Advanced 高級", classType: "3-4人小組授課", duration: 60, rate: 250 },

      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Elementary 初級", classType: "2人小組授課", duration: 60, rate: 275 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Elementary 初級", classType: "3-4人小組授課", duration: 60, rate: 180 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 30, rate: 310 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 45, rate: 420 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 60, rate: 530 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "2人小組授課", duration: 60, rate: 320 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "3-4人小組授課", duration: 60, rate: 215 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Advanced 高級", classType: "一對一個別授課 Individual", duration: 45, rate: 500 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Advanced 高級", classType: "一對一個別授課 Individual", duration: 60, rate: 620 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Advanced 高級", classType: "2人小組授課", duration: 60, rate: 380 },
      { tutor: "資深導師", instrument: "Fingerstyle Guitar", grade: "Advanced 高級", classType: "3-4人小組授課", duration: 60, rate: 250 },

      // 資深導師 - Acoustic Guitar
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "資深導師", instrument: "Acoustic Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },

      // 普通導師 - Classical Guitar
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 30, rate: 205 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 45, rate: 280 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 60, rate: 350 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "2人小組授課", duration: 60, rate: 215 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Pre Grade", classType: "3-4人小組授課", duration: 60, rate: 140 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 30, rate: 220 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 45, rate: 305 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 1", classType: "一對一個別授課 Individual", duration: 60, rate: 380 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 30, rate: 230 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 45, rate: 320 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 60, rate: 400 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 3", classType: "一對一個別授課 Individual", duration: 30, rate: 245 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 3", classType: "一對一個別授課 Individual", duration: 45, rate: 335 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 3", classType: "一對一個別授課 Individual", duration: 60, rate: 420 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 4", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 4", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 4", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 5", classType: "一對一個別授課 Individual", duration: 30, rate: 280 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 5", classType: "一對一個別授課 Individual", duration: 45, rate: 385 },
      { tutor: "普通導師", instrument: "Classical Guitar", grade: "Grade 5", classType: "一對一個別授課 Individual", duration: 60, rate: 480 },

      // 普通導師 - Pop / Fingerstyle Guitar
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Debut 入門", classType: "一對一個別授課 Individual", duration: 30, rate: 205 },
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Debut 入門", classType: "一對一個別授課 Individual", duration: 45, rate: 280 },
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Debut 入門", classType: "一對一個別授課 Individual", duration: 60, rate: 350 },
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 30, rate: 230 },
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 45, rate: 320 },
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 60, rate: 400 },
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "普通導師", instrument: "Pop Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 60, rate: 450 },

      { tutor: "普通導師", instrument: "Fingerstyle Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 30, rate: 230 },
      { tutor: "普通導師", instrument: "Fingerstyle Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 45, rate: 320 },
      { tutor: "普通導師", instrument: "Fingerstyle Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 60, rate: 400 },
      { tutor: "普通導師", instrument: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 30, rate: 260 },
      { tutor: "普通導師", instrument: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 45, rate: 360 },
      { tutor: "普通導師", instrument: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 60, rate: 450 }
    ];

    const defaultDatabase = [
        { id: "GAC0133", student: "Joseph", tutor: "普通導師", program: "Pop Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 60, discount: 1.0 },
        { id: "GAC0134", student: "Ella", tutor: "普通導師", program: "Fingerstyle Guitar", grade: "Intermediate 中級", classType: "一對一個別授課 Individual", duration: 60, discount: 1.0 },
        { id: "GAC0135", student: "Carly Chu", tutor: "普通導師", program: "Pop Guitar", grade: "Elementary 初級", classType: "一對一個別授課 Individual", duration: 45, discount: 1.0 },
        { id: "GAC0136", student: "Matthew LEE", tutor: "普通導師", program: "Classical Guitar", grade: "Grade 2", classType: "一對一個別授課 Individual", duration: 45, discount: 1.0 },
        { id: "GAC0137", student: "李逸朗", tutor: "普通導師", program: "Pop Guitar", grade: "Debut 入門", classType: "一對一個別授課 Individual", duration: 45, discount: 1.0 },
        { id: "GAC0139", student: "Cara Lui", tutor: "普通導師", program: "Classical Guitar", grade: "Pre Grade", classType: "一對一個別授課 Individual", duration: 45, discount: 1.0 }
    ];

