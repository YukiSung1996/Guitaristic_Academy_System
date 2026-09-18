// 脫敏測試名單：每導師 5–8 名學生。
// 情境覆蓋：S003/S004 = Instructor A 的 2 人小組（同時段豁免/TL 聯動測試）；
// 樂理 Grade 5 五人小組（Instructor B，週六 15:00）——其中 Student 020/021 同時有自己的一對一課，
// Student 030–032 只上小組課。同一人兩項報讀用「兩行、小組行 id 加 -T 後綴」表示：
// 學費按報讀項目分開計、薪酬人次分開列；「導師節數」按小組同時段合併為 1 節（lib/payroll.tutorSessions）。
const defaultStudents = [
            { id: "S001", name: "Student 001", phone: "00000000", email: "student001@example.com", type: "一對一", program: "Pop Guitar", level: "Intermediate 中級", duration: 45, tutor: "Instructor A", weekday: 1, time: "21:30", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S002", name: "Student 002", phone: "00000000", email: "student002@example.com", type: "一對一", program: "Hymns Guitar", level: "Intermediate 中級", duration: 45, tutor: "Instructor A", weekday: 3, time: "12:30", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S003", name: "Student 003", phone: "00000000", email: "student003@example.com", type: "2人小組", program: "Pop Guitar", level: "Elementary 初級", duration: 60, tutor: "Instructor A", weekday: 3, time: "21:30", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S004", name: "Student 004", phone: "00000000", email: "student004@example.com", type: "2人小組", program: "Pop Guitar", level: "Elementary 初級", duration: 60, tutor: "Instructor A", weekday: 3, time: "21:30", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S005", name: "Student 005", phone: "00000000", email: "student005@example.com", type: "一對一", program: "Acoustic Guitar", level: "Grade 5", duration: 45, tutor: "Instructor A", weekday: 2, time: "14:30", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S006", name: "Student 006", phone: "00000000", email: "student006@example.com", type: "一對一", program: "Hymns Guitar", level: "Intermediate 中級", duration: 45, tutor: "Instructor A", weekday: 3, time: "13:30", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S020", name: "Student 020", phone: "00000000", email: "student020@example.com", type: "一對一", program: "Pop Guitar", level: "Intermediate 中級", duration: 60, tutor: "Instructor B", weekday: 3, time: "18:00", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S021", name: "Student 021", phone: "00000000", email: "student021@example.com", type: "一對一", program: "Fingerstyle Guitar", level: "Intermediate 中級", duration: 60, tutor: "Instructor B", weekday: 2, time: "15:30", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S022", name: "Student 022", phone: "00000000", email: "student022@example.com", type: "一對一", program: "Pop Guitar", level: "Elementary 初級", duration: 45, tutor: "Instructor B", weekday: 2, time: "19:00", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S023", name: "Student 023", phone: "00000000", email: "student023@example.com", type: "一對一", program: "Classical Guitar", level: "Grade 2", duration: 45, tutor: "Instructor B", weekday: 2, time: "19:45", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S024", name: "Student 024", phone: "00000000", email: "student024@example.com", type: "一對一", program: "Pop Guitar", level: "Elementary 初級", duration: 45, tutor: "Instructor B", weekday: 2, time: "13:30", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            // ↓ 樂理 Grade 5 五人小組（同導師同時段 → 撞堂豁免、TL 聯動、導師節數合併為 1 節）
            { id: "S020-T", name: "Student 020", phone: "00000000", email: "student020@example.com", type: "5人小組", program: "Music Theory", level: "Grade 5", duration: 60, tutor: "Instructor B", weekday: 6, time: "15:00", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S021-T", name: "Student 021", phone: "00000000", email: "student021@example.com", type: "5人小組", program: "Music Theory", level: "Grade 5", duration: 60, tutor: "Instructor B", weekday: 6, time: "15:00", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S030", name: "Student 030", phone: "00000000", email: "student030@example.com", type: "5人小組", program: "Music Theory", level: "Grade 5", duration: 60, tutor: "Instructor B", weekday: 6, time: "15:00", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S031", name: "Student 031", phone: "00000000", email: "student031@example.com", type: "5人小組", program: "Music Theory", level: "Grade 5", duration: 60, tutor: "Instructor B", weekday: 6, time: "15:00", effectiveMonth: "", futureWeekday: null, futureTime: "" },
            { id: "S032", name: "Student 032", phone: "00000000", email: "student032@example.com", type: "5人小組", program: "Music Theory", level: "Grade 5", duration: 60, tutor: "Instructor B", weekday: 6, time: "15:00", effectiveMonth: "", futureWeekday: null, futureTime: "" }
        ];

        const groupCourses = [
            {
                id: "GROUP-01",
                name: "Demo Guitar Group 1",
                type: "班際課程",
                program: "Pop Guitar Beginner",
                level: "入門班 (每期 8 堂)",
                duration: 75,
                tutor: "Instructor A",
                weekday: 1,
                time: "19:00",
                totalLessons: 8,
                phone: "-",
                email: "contact@example.com",
                isGroupCourse: true
            },
            {
                id: "GROUP-02",
                name: "Demo Theory Group",
                type: "班際課程",
                program: "Grade 5 Theory Intensive",
                level: "精讀班 (每期 12 堂)",
                duration: 90,
                tutor: "Instructor A",
                weekday: 6,
                time: "15:00",
                totalLessons: 12,
                phone: "-",
                email: "contact@example.com",
                isGroupCourse: true
            }
        ];
