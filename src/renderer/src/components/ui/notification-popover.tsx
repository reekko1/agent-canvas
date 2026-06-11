import { useState } from "react"
import { Bell } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type Notification = {
  id: string
  title: string
  description: string
  timestamp: Date
  read: boolean
}

/** "now", "5m", "2h", then a date — activity rows are about recency. */
function timeAgo(date: Date): string {
  const s = Math.max(0, (Date.now() - date.getTime()) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return date.toLocaleDateString()
}

interface NotificationItemProps {
  notification: Notification
  index: number
  onClick: (notification: Notification) => void
  textColor?: string
  hoverBgColor?: string
  dotColor?: string
}

const NotificationItem = ({
  notification,
  index,
  onClick,
  textColor = "text-foreground",
  dotColor = "bg-(--status-blocked)",
  hoverBgColor = "hover:bg-muted/60",
}: NotificationItemProps) => (
  <motion.div
    initial={{ opacity: 0, x: 20, filter: "blur(10px)" }}
    animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
    transition={{ duration: 0.3, delay: index * 0.05 }}
    key={notification.id}
    className={cn(`p-4 ${hoverBgColor} cursor-pointer transition-colors`)}
    onClick={() => onClick(notification)}
  >
    <div className="flex justify-between items-start">
      <div className="flex items-center gap-2">
        {!notification.read && (
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
        )}
        <h4 className={`text-sm font-medium ${textColor}`}>
          {notification.title}
        </h4>
      </div>

      <span className={`text-xs opacity-80 ${textColor}`}>
        {timeAgo(notification.timestamp)}
      </span>
    </div>
    <p className={`text-xs opacity-70 mt-1 font-mono ${textColor}`}>
      {notification.description}
    </p>
  </motion.div>
)

interface NotificationListProps {
  notifications: Notification[]
  onItemClick: (notification: Notification) => void
  textColor?: string
  hoverBgColor?: string
  dividerColor?: string
}

const NotificationList = ({
  notifications,
  onItemClick,
  textColor,
  hoverBgColor,
  dividerColor = "divide-border/40",
}: NotificationListProps) => (
  <div className={`divide-y ${dividerColor}`}>
    {notifications.map((notification, index) => (
      <NotificationItem
        key={notification.id}
        notification={notification}
        index={index}
        onClick={onItemClick}
        textColor={textColor}
        hoverBgColor={hoverBgColor}
      />
    ))}
  </div>
)

interface NotificationPopoverProps {
  /** Controlled when paired with onNotificationsChange — the live-feed mode.
   *  Uncontrolled (internal state) otherwise. */
  notifications?: Notification[]
  onNotificationsChange?: (notifications: Notification[]) => void
  /** Row click, after mark-as-read — the fly-to-card hook. */
  onNotificationClick?: (notification: Notification) => void
  emptyMessage?: string
  buttonClassName?: string
  popoverClassName?: string
  textColor?: string
  hoverBgColor?: string
  dividerColor?: string
  headerBorderColor?: string
}

export const NotificationPopover = ({
  notifications: notificationsProp,
  onNotificationsChange,
  onNotificationClick,
  emptyMessage = "Nothing yet",
  buttonClassName = "rounded-2xl border border-border/40 bg-background/55 shadow-lg shadow-black/10 backdrop-blur-xl hover:bg-muted/60",
  popoverClassName = "border border-border/40 bg-background/70 backdrop-blur-xl",
  textColor = "text-foreground",
  hoverBgColor = "hover:bg-muted/60",
  dividerColor = "divide-border/40",
  headerBorderColor = "border-border/40",
}: NotificationPopoverProps) => {
  const [isOpen, setIsOpen] = useState(false)
  const [internal, setInternal] = useState<Notification[]>(
    notificationsProp ?? dummyNotifications,
  )
  // Controlled when the parent owns the array (the live feed); internal state
  // is only for standalone/demo use, where the list never changes from above.
  const controlled = notificationsProp !== undefined && onNotificationsChange !== undefined
  const notifications = controlled ? notificationsProp : internal

  const update = (updated: Notification[]) => {
    if (!controlled) setInternal(updated)
    onNotificationsChange?.(updated)
  }

  const unreadCount = notifications.filter((n) => !n.read).length

  const toggleOpen = () => setIsOpen(!isOpen)

  const markAllAsRead = () => {
    update(notifications.map((n) => ({ ...n, read: true })))
  }

  const handleItemClick = (notification: Notification) => {
    update(
      notifications.map((n) => (n.id === notification.id ? { ...n, read: true } : n)),
    )
    onNotificationClick?.(notification)
  }

  return (
    <div className={`relative ${textColor}`}>
      <Button
        onClick={toggleOpen}
        variant="ghost"
        size="icon"
        aria-label="Activity"
        className={cn("relative", buttonClassName)}
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <div className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-(--status-blocked) text-xs text-white">
            {unreadCount}
          </div>
        )}
      </Button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "absolute right-0 mt-2 w-80 max-h-[400px] overflow-y-auto rounded-xl shadow-lg",
              popoverClassName,
            )}
          >
            <div
              className={`p-4 border-b ${headerBorderColor} flex justify-between items-center`}
            >
              <h3 className="text-sm font-medium">Activity</h3>
              <Button
                onClick={markAllAsRead}
                variant="ghost"
                size="sm"
                className={`text-xs ${hoverBgColor}`}
              >
                Mark all as read
              </Button>
            </div>

            {notifications.length === 0 ? (
              <p className={`p-4 text-xs opacity-60 ${textColor}`}>{emptyMessage}</p>
            ) : (
              <NotificationList
                notifications={notifications}
                onItemClick={handleItemClick}
                textColor={textColor}
                hoverBgColor={hoverBgColor}
                dividerColor={dividerColor}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const dummyNotifications: Notification[] = [
  {
    id: "1",
    title: "New Message",
    description: "You have received a new message from John Doe",
    timestamp: new Date(),
    read: false,
  },
  {
    id: "2",
    title: "System Update",
    description: "System maintenance scheduled for tomorrow",
    timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000),
    read: false,
  },
  {
    id: "3",
    title: "Reminder",
    description: "Meeting with team at 2 PM",
    timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    read: true,
  },
]
