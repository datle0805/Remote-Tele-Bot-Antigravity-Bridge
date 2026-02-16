# Remote-Tele-Bot-Antigravity-Bridge

## Công Dụng

Script này kết nối **Telegram Bot** với **Antigravity IDE Tool**, cho phép bạn:

- 💬 **Chat từ xa với Agent**: Gửi tin nhắn từ Telegram để tương tác với Antigravity Agent
- 🎮 **Điều khiển bằng lệnh**: Bật/tắt chat, xem thông tin hạn mức (Quota)
- 📊 **Kiểm tra hạn mức**: Xem thông tin quota trực tiếp từ Telegram
- 🔄 **Nhận phản hồi tức thì**: Dùng polling để lắng nghe tin nhắn Telegram liên tục

## Đặc Tính Chính

- **Proactive Status Messages** (V13.0): Script tự động gửi trạng thái của Agent
- **Recursive Long Poll**: Lắng nghe tin nhắn Telegram nhanh chóng (timeout 30s)
- **Streaming Responses**: Xử lý các phản hồi dài từ Agent một cách trơn mượt
- **Command Control**: Hỗ trợ danh sách lệnh để quản lý bot

## Hướng Dẫn Cài Đặt

### 1. Lấy Telegram Bot Token

1. **Mở Telegram** và tìm **@BotFather**
2. Gửi lệnh `/start` rồi `/newbot`
3. **Đặt tên bot** (ví dụ: `My Antigravity Bot`)
4. **Đặt tên username** (ví dụ: `my_antigravity_bot`) - phải duy nhất
5. BotFather sẽ cấp cho bạn **Token**, có dạng:
   ```
   123456789:ABCdefGHIjklmnoPQRstuvwxyzABC-DE_fgh
   ```
6. **Sao chép Token** này

### 2. Lấy Telegram Chat ID

#### Cách 1: Dùng Bot để lấy Chat ID

1. Nhắn tin bất kỳ cho bot vừa tạo
2. Truy cập URL:
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```
   (Thay `YOUR_BOT_TOKEN` bằng token từ bước 1)
3. Tìm trong kết quả JSON, dòng `"chat":{"id":YOUR_CHAT_ID}`
4. **Sao chép Chat ID** (ví dụ: `987654321`)

#### Cách 2: Dùng @userinfobot trên Telegram

1. Tìm và mở **@userinfobot**
2. Gửi `/start`
3. Bot sẽ hiển thị **Your user ID** đó chính là Chat ID

#### Cách 3: Dùng Group Chat ID

- Nếu muốn nhắn tin vào group, Chat ID có dạng: `-100123456789`
- Để lấy, mỏi bạn cùng group gửi bot một tin nhắn, rồi kiểm tra `getUpdates`

### 3. Cấu Hình Script

1. Mở file `botRemoteChat.js`
2. Tìm phần CONFIG (dòng 5-7):
   ```javascript
   const CONFIG = {
     token: "YOUR_TELEGRAM_BOT_TOKEN", // <- Thay bằng token từ bước 1
     chatId: "YOUR_TELEGRAM_CHAT_ID", // <- Thay bằng chat ID từ bước 2
   };
   ```
3. **Lưu file**

### 4. Chạy Script trong Antigravity

1. Mở **Antigravity IDE** (https://antigravity.zone/)
2. Mở **DevTools** (F12 hoặc Ctrl+Shift+I)
3. Vào tab **Console**
4. **Copy toàn bộ code** từ `botRemoteChat.js`
5. **Paste** vào Console và bấm Enter
6. Bạn sẽ thấy tin nhắn: `🔄 Polling started`

## Danh Sách Lệnh

Gửi từ Telegram để điều khiển bot:

| Lệnh        | Công Dụng              |
| ----------- | ---------------------- |
| `/chat on`  | ✅ Bật chat với Agent  |
| `/chat off` | ⛔ Tắt chat với Agent  |
| `/quota`    | 📊 Xem hạn mức (Quota) |
| `/list`     | 🤖 Xem danh sách lệnh  |

## Cách Sử Dụng

1. **Gửi tin nhắn bình thường**: Script sẽ gửi nó vào Antigravity Agent
2. **Agent xử lý**: Agent trả lời câu hỏi/yêu cầu
3. **Nhận phản hồi**: Response từ Agent sẽ được gửi lại qua Telegram

## Lưu Ý

⚠️ **QUAN TRỌNG**:

- Giữ bí mật **Bot Token** - đó là mật khẩu truy cập bot của bạn
- Script chạy trong **Console** - tab này phải luôn mở
- Nếu đóng tab hoặc Antigravity, bot sẽ dừng hoạt động
- Để bot hoạt động 24/7, bạn cần host script trên server (không chạy trong trình duyệt)
