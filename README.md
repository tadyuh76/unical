<p align="center"><img src="public/logo/logo-128.png" width="112" alt=""></p>

# UniCal

Lịch học, lịch thi và deadline LMS của UEH tự động có trong Google Calendar.

[**Cài từ Chrome Web Store**](https://chromewebstore.google.com/detail/unical/fiennkdjfbpjomlbeeoadaibellmooac) · [unical.tadyuh.dev](https://unical.tadyuh.dev)

## Cách hoạt động

1. Cài UniCal, bấm **Kết nối Google Calendar** một lần.
2. Đăng nhập UEH Student và LMS một lần. Từ đó UniCal tự đọc lịch mới nhất khi bạn mở trình duyệt và mỗi giờ, không cần mở trang UEH nào.

Trong Google Calendar sẽ có 3 lịch riêng, bật/tắt được:

| Lịch | Nguồn | Cập nhật |
|---|---|---|
| UEH · Lịch học | UEH Student, từng tuần của học kỳ hiện tại và kỳ sau | 6 giờ/lần |
| UEH · Lịch thi | UEH Student, học kỳ hiện tại và kỳ sau | 3 giờ/lần trong nền, 10 phút/lần khi bạn mở UEH Student |
| UEH · Deadline | LMS: bài tập, quiz | mỗi giờ trong nền, 10 phút/lần khi bạn mở LMS |

- Lịch thi đổi giờ/phòng, Calendar đổi theo. Lớp bị huỷ, sự kiện tương lai bị xoá. Buổi đã qua được giữ lại.
- Deadline đã nộp được đánh dấu ✓ và tắt nhắc nhở.
- Lịch thi nhắc lúc 20:00 tối hôm trước và 1 giờ trước giờ thi. Deadline nhắc trước 1 ngày và 2 giờ.
- Phiên UEH Student hoặc LMS hết hạn: UniCal mở phiên mới qua trang đăng nhập của UEH (nút "Tiếp tục"), không bao giờ thấy hay dùng mật khẩu. Nếu UEH đã đăng xuất hẳn, UniCal nhắc bạn đăng nhập lại; deadline vẫn về qua link lịch riêng của LMS.
- Biểu tượng tiện ích hiện số deadline trong 3 ngày tới, hoặc "!" khi cần đăng nhập lại.
- Dùng Apple Calendar, Outlook, Notion Calendar: thêm tài khoản Google vào app, hoặc tải file `.ics` trong UniCal.

Chạy trên Chrome, Brave, Edge, Cốc Cốc và các trình duyệt Chromium khác.

## Quyền riêng tư

UniCal **không có server**. Dữ liệu chỉ đi giữa trình duyệt của bạn, trang UEH và Google Calendar của chính bạn. Quyền Google duy nhất UniCal xin là tạo lịch riêng và quản lý sự kiện trong các lịch đó; nó không thấy được lịch khác của bạn. Chi tiết: [Chính sách quyền riêng tư](https://unical.tadyuh.dev/privacy).

## Cấu trúc

```
src/ueh.ts         Đọc lịch học, lịch thi, deadline từ UEH Student và LMS; mở lại phiên qua trang đăng nhập UEH
src/content.ts     Chạy trên student.ueh.edu.vn và lms.ueh.edu.vn: đọc ngay khi bạn mở trang
src/offscreen.ts   Trang ẩn để đọc trang UEH khi cập nhật trong nền
src/background.ts  Đăng nhập Google, đồng bộ Calendar, cập nhật mỗi giờ và khi mở trình duyệt, badge
src/calendar.ts    Chuyển lịch học / lịch thi / deadline thành sự kiện (Google Calendar và .ics)
src/store.ts       Dữ liệu lưu trong trình duyệt
src/App.tsx        Popup
src/buddy.tsx      Linh vật UniCal, cũng là logo
```

## Phát triển

```bash
npm install
npm run build:local   # build/ có cùng ID với bản trên Chrome Web Store, nên đăng nhập Google hoạt động
```

Mở `chrome://extensions`, bật **Developer mode**, chọn **Load unpacked** và trỏ tới thư mục `build/`.
`npm run build` tạo bản để tải lên Chrome Web Store.

Nguồn dữ liệu (đều dùng phiên đăng nhập sẵn có của sinh viên):

| Dữ liệu | Endpoint |
|---|---|
| Học kỳ hiện tại | `student.ueh.edu.vn/Home/Schedules` |
| Danh sách tuần | `/Home/GetWeek/{năm}${học kỳ}` |
| Thời khoá biểu từng tuần | `/Home/DrawingSchedules?YearStudy=&TermID=&Week=` |
| Địa chỉ cơ sở | `/Home/DrawingStudentSchedule_Perior?YearStudy=&TermID=` |
| Lịch thi | `/Home/ShowExam?YearStudy=&TermID=` |
| Sự kiện LMS | Moodle AJAX `core_calendar_get_calendar_monthly_view`, `core_calendar_get_action_events_by_timesort` |
| Link lịch LMS | `lms.ueh.edu.vn/calendar/export.php` |
| Mở lại phiên | `loginst.ueh.edu.vn/?returnURL=`, rồi `/continue` |

Khi UEH đổi giao diện UEH Student hay LMS, chỗ cần sửa gần như luôn nằm trong `src/ueh.ts`.

## Đóng góp

Đây là bản cập nhật cuối của mình. UniCal giờ thuộc về cộng đồng UEH: mở issue, gửi pull request, hoặc fork để làm tiếp.

## Giấy phép

[MIT](LICENSE). UniCal không phải sản phẩm chính thức của UEH.
